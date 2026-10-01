import { test, expect } from "@playwright/test";

test("закрытые дела сохраняют вложенную группировку, длинная подзадача помещается в колонку", async ({ page, request }) => {
  await reset(request);
  const parent = await deed(request, "Дописываем карусель с генератором фраз и длинным названием родительской задачи", { due: day(0) });
  const child = await subOf(request, parent, "Проверить карусель");
  await request.post(`/api/captures/${child.id}/corrections`, { data: { patch: { schedule: { date: day(0) } } } });
  const done = await deed(request, "Закрытое дело сегодня", { due: day(0) });
  await closeDeed(request, done);
  await page.goto("/#board");
  await arrange(page, "board", ["col", "day", "src"]);
  const closed = page.locator(".board-done-column");
  await expect(closed.locator(".g-box > .g-bh").first()).toContainText("сегодня");
  await expect(closed.locator(".g-box .g-box .board-card.closed")).toHaveCount(1);
  await expect(closed.locator(".board-done")).toHaveAttribute("aria-label", "Вернуть в работу: Закрытое дело сегодня");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.locator("#board-columns .board-card").evaluateAll((cards) => cards.map((card) => {
      const box = card.getBoundingClientRect();
      const parent = card.parentElement.getBoundingClientRect();
      return Math.max(box.right - parent.right, parent.left - box.left, card.scrollWidth - card.clientWidth);
    }));
    expect(Math.max(...overflow)).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await closed.locator(".board-done").click();
  await expect(closed.locator(".board-card")).toHaveCount(0);
  await closeDeed(request, done);
  await arrange(page, "list", ["col", "day", "src"]);
  await expect(page.locator("#board-flat .g-kids.done .g-sec").first()).toContainText("сегодня");
  await expect(page.locator("#board-flat .g-kids.done .g-row.closed")).toHaveCount(1);
  await reset(request);
});

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
// shown — колонки-группы, которые человек завёл сам, {"day": ["week"]}: пустые группы
// на доске сами не появляются, тесты, которым они нужны, заводят их так же, как человек.
const arrange = async (page, view, groups, shown = null) => {
  await page.evaluate(([v, g, s]) => {
    localStorage.setItem("kizuna-board-view", v);
    localStorage.setItem("kizuna-board-groups", JSON.stringify(g));
    if (s) localStorage.setItem("kizuna-board-shown", JSON.stringify(s));
  }, [view, groups, shown]);
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
// Колонка-группа: группа, которую на доске ещё нет, выбирают в «+ Колонка» в конце ряда.
const groupGhost = (page) => page.locator(".board-column.ghost.pick");
const groupLaneNames = (page) => page.locator("#board-columns .board-column.group .board-col-name").allTextContents();
const addGroupColumn = async (page, label) => {
  const ghost = groupGhost(page);
  if ((await ghost.locator(".board-add-button").getAttribute("aria-expanded")) !== "true") await ghost.locator(".board-add-button").click();
  await ghost.locator(".board-pick-item", { hasText: new RegExp(`^${label}$`) }).click();
  await expect(page.locator(".board-column.group .board-col-name", { hasText: new RegExp(`^${label}$`) })).toBeVisible();
};

// Фильтр и порядок колонок помнятся в браузере. Прогон стартует с пустого фильтра
// (tests/fixtures/e2e-auth.setup.js): в первый заход доска показывала бы только
// «сегодня». Проверки умолчания сами убирают ключ.
const stored = (page, key) => page.evaluate((name) => localStorage.getItem(name), key);
const filterToggle = (page) => page.locator("#board-filter-toggle");
const openFilter = async (page) => { if ((await filterToggle(page).getAttribute("aria-expanded")) !== "true") await filterToggle(page).click(); };
const condition = (page, index) => page.locator("#board-filter .board-cond").nth(index);
// Значения условия отмечают галочками в списке под кнопкой значений; «или» — это две галочки.
const tickValues = async (page, index, values) => {
  const chip = condition(page, index);
  if ((await chip.locator(".board-vals-btn").getAttribute("aria-expanded")) !== "true") await chip.locator(".board-vals-btn").click();
  for (const value of values) await chip.locator(`.board-vals-pop input[value="${value}"]`).setChecked(true);
  await page.keyboard.press("Escape");
};
// Условие набирается руками, как это делает человек: «+ условие», поле, оператор, значения.
// Новое условие встаёт в конец строки; values — одно значение или несколько («или»).
const addCondition = async (page, field, values, op = "=") => {
  await openFilter(page);
  const index = await page.locator("#board-filter .board-cond").count();
  await page.locator("#board-filter .board-cond-add").click();
  await condition(page, index).locator('[data-part="field"]').selectOption(field);
  if (op !== "=") await condition(page, index).locator('[data-part="op"]').selectOption(op);
  await tickValues(page, index, [].concat(values));
};
// Как плашки читаются глазами: «День = сегодня или просрочено».
const conditionsOf = (page) => page.locator("#board-filter .board-cond").evaluateAll((chips) => chips.map((chip) => [...[...chip.querySelectorAll("select")].map((select) => select.selectedOptions[0].textContent), chip.querySelector(".board-vals-btn").textContent.replace(/\s+/g, " ").trim()].join(" ")));
const closeDeed = async (request, id) => {
  const entry = (await (await request.get(`/api/captures/${id}`)).json()).entry;
  for (const projection of entry.projections.filter((item) => item.type === "task")) await request.post(`/api/projections/${projection.id}/complete`, { data: {} });
};
const openTitles = (page) => page.locator("#board-columns .board-column:not(.board-done-column) .board-card .board-title").allTextContents();
const doneTitles = (page) => page.locator("#board-columns .board-done-column .board-card .board-title").allTextContents();
const idByRaw = async (request, raw) => (await (await request.get("/api/entries?limit=50")).json()).entries.find((entry) => entry.raw === raw)?.id;

test("доска: «Закрыто» — обычная колонка, своя колонка, быстрое дело, карточка и кружок", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#board");

  // Свойств нет; над доской — вид, группировка и «Фильтр», по умолчанию «Доска» по
  // колонкам. «Закрыто» — обычная колонка и по умолчанию первая, за ней «Дела»
  // (заводится сервером сама) и призрачная «+ Колонка».
  await expect(page.locator("#board-props-toggle")).toHaveCount(0);
  await expect(page.locator("#board-filter-toggle")).toHaveText("Фильтр");
  await expect(page.locator("#board-view button")).toHaveText(["Доска", "Список"]);
  await expect(page.locator("#board-view button[aria-pressed=true]")).toHaveText("Доска");
  expect(await groupsOf(page)).toEqual(["col"]);
  await expect(page.locator(".board-column:not(.ghost) .board-col-name")).toHaveText(["Закрыто", "Дела"]);
  await expect(page.locator(".board-column.inbox")).toHaveCount(0);
  await expect(page.locator(".board-column.ghost")).toBeVisible();
  await expect(page.locator(".board-column.board-done-column .board-col-name")).toHaveAttribute("href", "#done");
  // «Закрыто» такая же колонка: заголовок тянется, а стоит она в потоке, а не прибита
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

  // Кружок отправляет дело в «Закрыто»: оно там зачёркнуто, подпись — «сегодня 10:12».
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

  // Заголовок «Закрыто» ведёт на страницу «Сделано».
  await done.locator(".board-col-name").click();
  await expect(page).toHaveURL(/#done$/);
  await expect(page.locator("#done h2")).toHaveText("Сделано");

  await reset(request);
});

test("доска: карточку бросают в «Закрыто» и между колонками, колонку тянут за заголовок", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/captures", { data: { raw: "Первое дело доски" } });
  await request.post("/api/captures", { data: { raw: "Второе дело доски" } });
  await page.goto("/#board");
  await addColumn(page, "Позже");
  await addColumn(page, "Ожидание");
  const names = () => page.locator(".board-column:not(.ghost) .board-col-name").allTextContents();
  await expect.poll(names).toEqual(["Закрыто", "Дела", "Позже", "Ожидание"]);

  // Карточка между колонками: «Второе» уезжает из «Дел» в «Позже».
  const first = columnByName(page, "Дела"), later = columnByName(page, "Позже");
  const second = first.locator(".board-card").filter({ hasText: "Второе дело" });
  await expect(second).toBeVisible();
  await second.locator(".board-title").dragTo(later.locator(".board-cards"));
  await expect(later.locator(".board-card").filter({ hasText: "Второе дело" })).toBeVisible();
  await expect(first.locator(".board-card")).toHaveCount(1);
  await page.reload();
  await expect(columnByName(page, "Позже").locator(".board-card")).toContainText("Второе дело");

  // Колонка тянется за заголовок: «Ожидание» встаёт перед «Дела» (правее «Закрыто»,
  // которая пока стоит первой) и после перезагрузки остаётся там.
  await columnByName(page, "Ожидание").locator(".board-col-head").dragTo(columnByName(page, "Дела"), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(["Закрыто", "Ожидание", "Дела", "Позже"]);
  await page.reload();
  await expect.poll(names).toEqual(["Закрыто", "Ожидание", "Дела", "Позже"]);

  // Бросили карточку на «Закрыто» — она закрыта и лежит там. Карточка без места
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
  // Доска просит себя с «?subtasks=1» (по умолчанию подзадачи показываются), поэтому считаем по пути, а не по концу адреса.
  const reads = () => page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === "/api/board").length);
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

  // «+ Дело» вверху открывает поле в первой своей колонке, а не в «Закрыто».
  await page.locator("#board-new").click();
  await expect(columnByName(page, "Текущие").locator(".board-add input")).toBeVisible();
  await reset(request);
});

// На телефоне колонки по одной на экран: сверху сегмент подписей, открыта
// первая своя колонка (а не «Закрыто»), страница не шире экрана.
test("на телефоне колонки по одной, сегмент показывает «Закрыто» и свои", async ({ page, request }) => {
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
  await expect(page.locator("#board-segments .board-segment").first()).toContainText("Закрыто");
  await expect(page.locator("#board-columns .board-column.is-active")).toHaveCount(1);
  await expect(page.locator("#board-columns .board-column.is-active .board-col-name")).toHaveText("Дела");
  // Сегмент «Закрыто» показывает закрытые; страница не шире экрана.
  await page.locator("#board-segments .board-segment").first().click();
  await expect(page.locator("#board-columns .board-column.is-active .board-col-name")).toHaveText("Закрыто");
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
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Закрыто · 0"]);
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

  // Вида «Таблица» больше нет: сохранённый прежде в браузере читается как «Список».
  await page.evaluate(() => localStorage.setItem("kizuna-board-view", "table"));
  await page.reload();
  await expect(page.locator("#board-view button[aria-pressed=true]")).toHaveText("Список");
  await expect(page.locator("#board-flat .g-list")).toBeVisible();
  await expect(page.locator("#board-columns")).toBeHidden();

  // Испорченное значение в браузере не ломает доску: вид и группировка по умолчанию.
  await page.evaluate(() => { localStorage.setItem("kizuna-board-view", "cards"); localStorage.setItem("kizuna-board-groups", "{oops"); });
  await page.reload();
  await expect(page.locator("#board-view button[aria-pressed=true]")).toHaveText("Доска");
  expect(await groupsOf(page)).toEqual(["col"]);
  await reset(request);
});

test("по дню: на доске только непустые группы и заведённые, бросок в другой день меняет срок, в «просрочено» не принимается", async ({ page, request }) => {
  await reset(request);
  const first = await deed(request, "Дело на сегодня", { due: day(0) });
  const second = await deed(request, "Дело на завтра", { due: day(1) });
  await deed(request, "Дело со вчерашним сроком", { due: day(-1) });
  // «Закрыто» и шесть групп-колонок в ряд: окно широкое, чтобы все они были видны без прокрутки ленты.
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.goto("/#board");
  await arrange(page, "board", ["day"]);
  const names = () => page.locator("#board-columns .board-column.group .board-col-name").allTextContents();
  // Пустые дни сами не появляются: стоят «просрочено», «сегодня» и «завтра» — там, где есть дела.
  await expect.poll(names).toEqual(["просрочено", "сегодня", "завтра"]);
  // Куда бросать, человек заводит сам: «+ Колонка» в конце ряда, и каждая новая встаёт последней.
  for (const name of ["на неделе", "позже", "без срока"]) await addGroupColumn(page, name);
  await expect.poll(names).toEqual(["просрочено", "сегодня", "завтра", "на неделе", "позже", "без срока"]);
  // У колонок-групп есть меню («Убрать колонку»), заголовок тянется, как у колонок человека;
  // «Закрыто» по умолчанию слева, перед всеми. Все шесть дней на доске — добавлять больше нечего,
  // и «+ Колонка» не показывается.
  await expect(page.locator(".board-column.group .board-menu")).toHaveCount(6);
  await expect(page.locator(".board-column.ghost.pick")).toHaveCount(0);
  await expect(page.locator(".board-column.group .board-col-head[draggable=true]")).toHaveCount(6);
  await expect(page.locator("#board-columns .board-column").first()).toHaveClass(/board-done-column/);
  await expect(page.locator(".board-done-column .board-col-name")).toHaveText("Закрыто");
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

test("по человеку: группы по алфавиту, «Без человека» последней; карточки не тянутся, у колонок меню «Убрать колонку»", async ({ page, request }) => {
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
  // У колонок-групп меню с одним пунктом, а «+» добавить дело в шапке нет. Все, кто есть в делах, и
  // «Без человека» уже на доске — выбирать в «+ Колонка» нечего, и её нет.
  await expect(page.locator(".board-column.group .board-menu")).toHaveCount(3);
  await expect(page.locator(".board-column.group .board-col-plus")).toHaveCount(0);
  await expect(groupGhost(page)).toHaveCount(0);
  // Карточки тут не тянутся, а колонки — да: заголовок любой группы двигает саму колонку.
  await expect(page.locator(".board-column.group .board-col-head[draggable=true]")).toHaveCount(3);
  // Проект и «Откуда» ведут себя так же: «Без проекта» последней, откуда — «Поле».
  await page.locator("#board-grp select").selectOption("proj");
  await expect.poll(names).toEqual(["Без проекта"]);
  await page.locator("#board-grp select").selectOption("src");
  await expect.poll(names).toEqual(["Поле"]);
  await reset(request);
});

test("список: разделы по колонкам, «Закрыто» — последний раздел, кружок закрытого возвращает дело", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Открытое дело списка");
  const finished = await deed(request, "Закрытое дело списка");
  const entry = (await (await request.get(`/api/captures/${finished}`)).json()).entry;
  for (const projection of entry.projections.filter((item) => item.type === "task")) await request.post(`/api/projections/${projection.id}/complete`, { data: {} });
  await page.goto("/#board");
  await arrange(page, "list", ["col"]);
  await expect(page.locator("#board-columns")).toBeHidden();
  // Раздел колонки, за ним — «Закрыто»: зелёный, последний, ведёт на страницу «Сделано».
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 1", "Закрыто · 1"]);
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
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 2", "Закрыто · 0"]);
  await settled(page);
  await page.locator("#board-flat .g-row").filter({ hasText: "Открытое дело списка" }).locator(".board-done").click();
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 1", "Закрыто · 1"]);
  await expect(page.locator("#board-flat .g-row.closed")).toContainText("Открытое дело списка");
  await reset(request);
});

test("поиск работает на доске и в списке; название открывает карточку, стрелки листают дела в порядке показа", async ({ page, request }) => {
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

test("клавиши J, E и Enter работают в списке так же, как на доске", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Первая строка для клавиш");
  await deed(request, "Вторая строка для клавиш");
  await page.goto("/#board");
  await arrange(page, "list", []);
  const rows = page.locator("#board-flat .g-row:not(.closed)");
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

test("на телефоне у списка нет сегментов колонок и он не шире экрана", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело для телефона со длинным названием, чтобы строка списка не поместилась в одну линию", { due: day(1) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#board");
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
  // Пока порядка нет — естественный, «Закрыто» первая; пустые дни не показаны — их никто не заводил.
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра"]);
  expect(await stored(page, "kizuna-board-order")).toBeNull();

  // «завтра» — за заголовок — перед «сегодня». Колонка переехала, а срок дела остался.
  await lane("tomorrow").locator(".board-col-head").dragTo(lane("today"), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(["Закрыто", "завтра", "сегодня"]);
  expect(await dueOf(request, tomorrow)).toBe(day(1));
  // В браузере лежит полный порядок — и скрытые «просрочено», «на неделе», … тоже, на своих местах.
  expect(JSON.parse(await stored(page, "kizuna-board-order"))).toEqual({ day: ["__done", "late", "tomorrow", "today", "week", "later", "none"] });
  await page.reload();
  await expect.poll(names).toEqual(["Закрыто", "завтра", "сегодня"]);
  await expect(lane("tomorrow").locator(".board-card")).toContainText("Дело на завтра");

  // Порядок помнится по полю первого уровня: у другого поля он свой, естественный.
  await arrange(page, "board", ["src"]);
  await expect.poll(names).toEqual(["Закрыто", "Поле"]);
  await arrange(page, "board", ["day"]);
  await expect.poll(names).toEqual(["Закрыто", "завтра", "сегодня"]);
  await reset(request);
});

test("«Закрыто» — такая же колонка: её тянут на второе место, и это помнится; новая группа встаёт после известных", async ({ page, request }) => {
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
  await expect.poll(names).toEqual(["Закрыто", "просрочено", "сегодня"]);

  // «Закрыто» встала правее «просрочено»: вторая по счёту, а не прибитая к краю.
  await done.locator(".board-col-head").dragTo(lane("late"), { targetPosition: { x: 260, y: 60 } });
  await expect.poll(names).toEqual(["просрочено", "Закрыто", "сегодня"]);
  await expect(done.locator(".board-card.closed")).toContainText("Закрытое дело");
  await page.reload();
  await expect.poll(names).toEqual(["просрочено", "Закрыто", "сегодня"]);
  expect(JSON.parse(await stored(page, "kizuna-board-order")).day.slice(0, 3)).toEqual(["late", "__done", "today"]);
  // Она обычная и в остальном: закрывает брошенное на неё дело.
  await lane("today").locator(".board-card").filter({ hasText: "Дело на сегодня" }).locator(".board-title").dragTo(page.locator(".board-done-column"));
  await expect(done.locator(".board-card.closed")).toHaveCount(2);

  // Порядок из браузера знает не все группы: новый человек встаёт после известных, в естественном порядке.
  await page.evaluate(() => localStorage.setItem("kizuna-board-order", JSON.stringify({ who: ["Борис", "__done"] })));
  await arrange(page, "board", ["who"]);
  await expect.poll(names).toEqual(["Борис", "Закрыто", "Аня", "Без человека"]);
  // Испорченный порядок не ломает доску: естественный, «Закрыто» первая.
  await page.evaluate(() => localStorage.setItem("kizuna-board-order", "{oops"));
  await page.reload();
  await expect.poll(names).toEqual(["Закрыто", "Аня", "Борис", "Без человека"]);
  await reset(request);
});

test("по «Колонке» колонка человека тянется и порядок уходит на сервер, а место «Закрыто» — только в браузере", async ({ page, request }) => {
  await reset(request);
  await request.post("/api/board/columns", { data: { name: "Позже" } });
  await request.post("/api/board/columns", { data: { name: "Ожидание" } });
  await page.goto("/#board");
  const names = () => page.locator(".board-column:not(.ghost) .board-col-name").allTextContents();
  const server = async () => (await (await request.get("/api/board")).json()).columns.map((column) => column.name);
  await expect.poll(names).toEqual(["Закрыто", "Дела", "Позже", "Ожидание"]);

  // «Ожидание» перед «Позже»: на экране, в браузере и на сервере.
  await columnByName(page, "Ожидание").locator(".board-col-head").dragTo(columnByName(page, "Позже"), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(["Закрыто", "Дела", "Ожидание", "Позже"]);
  await expect.poll(server).toEqual(["Дела", "Ожидание", "Позже"]);
  expect(JSON.parse(await stored(page, "kizuna-board-order")).col).toHaveLength(4);

  // «Закрыто» на второе место — только на экране: свои колонки на сервере стоят, как стояли.
  await page.locator(".board-done-column .board-col-head").dragTo(columnByName(page, "Дела"), { targetPosition: { x: 260, y: 60 } });
  await expect.poll(names).toEqual(["Дела", "Закрыто", "Ожидание", "Позже"]);
  expect(await server()).toEqual(["Дела", "Ожидание", "Позже"]);
  await page.reload();
  await expect.poll(names).toEqual(["Дела", "Закрыто", "Ожидание", "Позже"]);

  // Колонка человека, брошенная за «Закрыто», тоже уходит на сервер — среди своих колонок она первая.
  await columnByName(page, "Позже").locator(".board-col-head").dragTo(columnByName(page, "Дела"), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(["Позже", "Дела", "Закрыто", "Ожидание"]);
  await expect.poll(server).toEqual(["Позже", "Дела", "Ожидание"]);
  await reset(request);
});

// ── колонки-группы, которые человек заводит сам ──────────────────────────────

test("колонки-группы заводит человек: «+ Колонка» добавляет «на неделе», она помнится, «Убрать колонку» прячет пустую, а с делами колонка остаётся", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело на сегодня", { due: day(0) });
  await deed(request, "Дело на завтра", { due: day(1) });
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.goto("/#board");
  await arrange(page, "board", ["day"]);
  const names = () => page.locator("#board-columns .board-column:not(.ghost) .board-col-name").allTextContents();
  const lane = (key) => page.locator(`.board-column.group[data-group="day:${key}"]`);

  // Пустых дней на доске нет: стоят только те, где есть дела; ничего заведённого в браузере нет.
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра"]);
  expect(await stored(page, "kizuna-board-shown")).toBeNull();
  // «+ Колонка» — в конце ряда; дни на доске есть, поэтому подсказки про пустую доску нет.
  const ghost = groupGhost(page);
  await expect(ghost).toBeVisible();
  await expect(page.locator("#board-columns .board-column").last()).toHaveClass(/ghost/);
  await expect(ghost.locator(".board-lanes-hint")).toHaveCount(0);
  await expect(ghost.locator(".board-pick-list")).toBeHidden();
  // Она предлагает то, чего на доске ещё нет, — не «сегодня» и не «завтра». Escape закрывает выбор, ничего не добавив.
  await ghost.locator(".board-add-button").click();
  await expect(ghost.locator(".board-add-button")).toHaveAttribute("aria-expanded", "true");
  await expect(ghost.locator(".board-pick-item")).toHaveText(["просрочено", "на неделе", "позже", "без срока"]);
  await page.keyboard.press("Escape");
  await expect(ghost.locator(".board-pick-list")).toBeHidden();
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра"]);
  // Выбрали «на неделе» — колонка появилась пустой и последней в ряду, а «+ Колонка» встала за ней.
  await ghost.locator(".board-add-button").click();
  await ghost.locator(".board-pick-item", { hasText: /^на неделе$/ }).click();
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра", "на неделе"]);
  await expect(lane("week").locator(".board-card")).toHaveCount(0);
  await expect(lane("week").locator(".board-col-count")).toHaveText("0");
  await expect(page.locator("#board-columns .board-column").last()).toHaveClass(/ghost/);
  await expect(ghost.locator(".board-pick-list")).toBeHidden();
  expect(JSON.parse(await stored(page, "kizuna-board-shown"))).toEqual({ day: ["week"] });
  // Предложений стало меньше: «на неделе» уже на доске. А «просрочено» — первое по порядку дней — встаёт всё равно последним.
  await ghost.locator(".board-add-button").click();
  await expect(ghost.locator(".board-pick-item")).toHaveText(["просрочено", "позже", "без срока"]);
  await ghost.locator(".board-pick-item", { hasText: /^просрочено$/ }).click();
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра", "на неделе", "просрочено"]);
  expect(JSON.parse(await stored(page, "kizuna-board-shown"))).toEqual({ day: ["week", "late"] });
  // Порядок лежит рядом, в своём ключе, прежнего формата — целиком, со скрытыми «позже» и «без срока» на местах.
  expect(JSON.parse(await stored(page, "kizuna-board-order"))).toEqual({ day: ["__done", "today", "tomorrow", "week", "late", "later", "none"] });
  // После перезагрузки колонки на месте: они заведены, хоть и пусты.
  await page.reload();
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра", "на неделе", "просрочено"]);

  // «Убрать колонку» прячет пустую: она уходит и не возвращается после перезагрузки.
  await lane("week").hover();
  const menu = lane("week").locator(".board-menu");
  await menu.locator("summary").click();
  await expect(menu.locator(".board-menu-popover button")).toHaveText(["Убрать колонку"]);
  await expect(menu.locator(".board-menu-note")).toHaveText("Вернуть колонку можно через «+ Колонка».");
  await menu.getByRole("button", { name: "Убрать колонку" }).click();
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра", "просрочено"]);
  expect(JSON.parse(await stored(page, "kizuna-board-shown"))).toEqual({ day: ["late"] });
  await page.reload();
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра", "просрочено"]);
  // Убранную можно вернуть тем же «+ Колонка».
  await addGroupColumn(page, "на неделе");
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра", "просрочено", "на неделе"]);

  // С делами колонка остаётся: «Убрать» её только не держит — она уйдёт, когда дела закончатся. Сказано в меню и в тосте.
  await lane("today").hover();
  await lane("today").locator(".board-menu summary").click();
  await expect(lane("today").locator(".board-menu-note")).toContainText("есть дела");
  await lane("today").getByRole("button", { name: "Убрать колонку" }).click();
  await expect(page.locator("#toast")).toContainText("Колонка «сегодня» уйдёт, когда в ней не останется дел");
  await expect(lane("today")).toBeVisible();
  await expect(lane("today").locator(".board-card")).toHaveCount(1);
  // Закрыли единственное дело — колонка ушла сама: непустая колонка держится на делах, а не на выборе.
  await lane("today").locator(".board-done").click();
  await expect.poll(names).toEqual(["Закрыто", "завтра", "просрочено", "на неделе"]);
  await reset(request);
});

test("пустая доска по группе говорит, что делать: «Колонок по дню пока нет — добавьте нужные через «+ Колонка»»", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#board");
  await arrange(page, "board", ["day"]);
  const hint = page.locator(".board-column.ghost.pick .board-lanes-hint");
  await expect(page.locator("#board-columns .board-column.group")).toHaveCount(0);
  await expect(hint).toHaveText("Колонок по дню пока нет — добавьте нужные через «+ Колонка»");
  // Так же для других полей.
  for (const [field, by] of [["who", "человеку"], ["proj", "проекту"], ["src", "источнику"]]) {
    await page.locator("#board-grp select").selectOption(field);
    await expect(hint).toHaveText(`Колонок по ${by} пока нет — добавьте нужные через «+ Колонка»`);
  }
  // Подсказка стоит там же, где кнопка: по ней и добавляют. Завели колонку — подсказка больше не нужна.
  await page.locator("#board-grp select").selectOption("day");
  await addGroupColumn(page, "сегодня");
  await expect(hint).toHaveCount(0);
  await expect(page.locator("#board-columns .board-column.group")).toHaveCount(1);
  // Без группировки и по «Колонке» подсказки нет: там колонки не выбирают из значений поля.
  await page.locator("#board-grp [data-remove]").first().click();
  await expect(page.locator(".board-lanes-hint, .board-column.ghost.pick")).toHaveCount(0);
  await reset(request);
});

test("«+ Колонка» у человека, проекта и «Откуда» предлагает значения из карточек; заведённая колонка пуста и принимает «+ Дело — …»", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело для Ани", { people: ["Аня"] });
  await deed(request, "Дело для Бориса", { people: ["Борис"] });
  await deed(request, "Дело без людей");
  await closeDeed(request, await deed(request, "Закрытое дело Игоря", { people: ["Игорь"] }));
  const hub = await deed(request, "Дело проекта Hub");
  await request.post(`/api/captures/${hub}/corrections`, { data: { at: Date.now(), patch: { project: "Hub" } } });
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.goto("/#board");
  const names = () => page.locator("#board-columns .board-column:not(.ghost) .board-col-name").allTextContents();

  // Человек: стоят те, у кого есть открытые дела, и «Без человека»; Игорь — только в закрытом, его колонку заводят сами.
  await arrange(page, "board", ["who"]);
  await expect.poll(names).toEqual(["Закрыто", "Аня", "Борис", "Без человека"]);
  const ghost = groupGhost(page);
  await ghost.locator(".board-add-button").click();
  await expect(ghost.locator(".board-pick-item")).toHaveText(["Игорь"]);
  await ghost.locator(".board-pick-item").click();
  await expect.poll(names).toEqual(["Закрыто", "Аня", "Борис", "Без человека", "Игорь"]);
  expect(JSON.parse(await stored(page, "kizuna-board-shown"))).toEqual({ who: ["Игорь"] });
  // Всё есть на доске — «+ Колонка» не нужна и не показывается.
  await expect(groupGhost(page)).toHaveCount(0);
  // Заведённая колонка пуста, и в ней стоит «+ Дело — Игорь»: новое дело ложится в неё.
  const igor = page.locator('.board-column.group[data-group="who:Игорь"]');
  await expect(igor.locator(".board-card")).toHaveCount(0);
  await igor.hover();
  await igor.locator(".board-add-button").click();
  await expect(igor.locator(".board-add-button")).toBeHidden();
  await igor.locator(".board-add input").fill("Позвонить Игорю");
  await page.keyboard.press("Enter");
  await expect(igor.locator(".board-card").filter({ hasText: "Позвонить Игорю" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Колонка человека пережила перезагрузку и держится на делах: «Убрать» её не уберёт, пока дело в ней.
  await page.reload();
  await expect.poll(names).toEqual(["Закрыто", "Аня", "Борис", "Без человека", "Игорь"]);

  // Проект: «Hub» и «Без проекта» уже на доске, предлагать нечего.
  await arrange(page, "board", ["proj"]);
  await expect.poll(names).toEqual(["Закрыто", "Hub", "Без проекта"]);
  await expect(groupGhost(page)).toHaveCount(0);
  // «Откуда»: у всех дел «Поле»; Telegram и «Заметки» — выбор.
  await arrange(page, "board", ["src"]);
  await expect.poll(names).toEqual(["Закрыто", "Поле"]);
  await groupGhost(page).locator(".board-add-button").click();
  await expect(groupGhost(page).locator(".board-pick-item")).toHaveText(["Telegram", "Заметки"]);
  await groupGhost(page).locator(".board-pick-item", { hasText: /^Telegram$/ }).click();
  await expect.poll(names).toEqual(["Закрыто", "Поле", "Telegram"]);
  await expect(page.locator('.board-column.group[data-group="src:telegram"] .board-card')).toHaveCount(0);
  await reset(request);
});

test("на телефоне «+ Колонка» у групп — сегмент; выбор открывается в нём, новая колонка открыта", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело на сегодня для телефона", { due: day(0) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#board");
  await arrange(page, "board", ["day"]);
  const segments = page.locator("#board-segments .board-segment");
  await expect(segments).toContainText(["Закрыто", "сегодня", "+ Колонка"]);
  await segments.last().click();
  await expect(page.locator("#board-columns .board-column.ghost.pick.is-active")).toBeVisible();
  await groupGhost(page).locator(".board-add-button").click();
  await groupGhost(page).locator(".board-pick-item", { hasText: /^завтра$/ }).click();
  // Новая колонка — та, что открыта; сегмент её называет; страница не шире экрана.
  await expect(page.locator("#board-columns .board-column.is-active .board-col-name")).toHaveText("завтра");
  await expect(segments).toContainText(["Закрыто", "сегодня", "завтра", "+ Колонка"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await reset(request);
});

// ── наборный фильтр ──────────────────────────────────────────────────────────

test("первый заход: фильтр «сегодня» — одна плашка «День = сегодня или просрочено»; «Сбросить» показывает всё и помнится, «Сегодня» возвращает умолчание", async ({ page, request }) => {
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

  // Кнопка подсвечена и считает плашки; строка открыта, плашка одна: «или» стоит внутри неё,
  // «и» между плашками не нужно.
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  await expect(filterToggle(page)).toHaveClass(/is-on/);
  await expect(page.locator("#board-filter")).toBeVisible();
  expect(await conditionsOf(page)).toEqual(["День = сегодня или просрочено"]);
  await expect(page.locator("#board-filter .board-vals-btn .board-or")).toHaveText("или");
  await expect(page.locator("#board-filter .board-and")).toHaveCount(0);
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
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  expect(await conditionsOf(page)).toEqual(["День = сегодня или просрочено"]);
  await expect.poll(() => openTitles(page)).toEqual(["Просроченное дело для фильтра", "Дело на сегодня для фильтра"]);
  // В браузер умолчание попадает новым форматом: одно условие, два значения.
  expect(JSON.parse(await stored(page, "kizuna-board-filter"))).toEqual([{ field: "day", op: "=", values: ["today", "late"] }]);
  await page.reload();
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  await expect.poll(() => openTitles(page)).toHaveLength(2);

  // Второе значение можно снять в списке: остаётся «День = сегодня».
  await condition(page, 0).locator(".board-vals-btn").click();
  await condition(page, 0).locator('.board-vals-pop input[value="late"]').uncheck();
  await page.keyboard.press("Escape");
  expect(await conditionsOf(page)).toEqual(["День = сегодня"]);
  await expect.poll(() => openTitles(page)).toEqual(["Дело на сегодня для фильтра"]);
  await expect(page.locator("#board-filter .board-filter-today")).toHaveAttribute("aria-pressed", "false");
  await reset(request);
});

test("фильтр «Человек = Аня» оставляет её дела на доске и в списке, переживает перезагрузку, «Сбросить» возвращает всё", async ({ page, request }) => {
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
  // Доска: только её открытые дела (в том числе общее с Борисом) и её закрытое в «Закрыто».
  await expect.poll(() => openTitles(page)).toEqual(["Дело Ани для фильтра", "Общее дело для фильтра"]);
  await expect.poll(() => doneTitles(page)).toEqual(["Закрытое дело Ани"]);
  await expect(page.locator(".board-done-column .board-col-count")).toHaveText("1");
  // Поиск работает поверх фильтра.
  await page.locator("#board-search").fill("общее");
  await expect.poll(() => openTitles(page)).toEqual(["Общее дело для фильтра"]);
  await page.locator("#board-search").fill("");

  // Список: те же дела, «Закрыто» — последний раздел с её закрытым.
  await page.locator('#board-view [data-view="list"]').click();
  await expect(page.locator("#board-flat .g-row .board-title")).toHaveText(["Дело Ани для фильтра", "Общее дело для фильтра", "Закрытое дело Ани"]);
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 2", "Закрыто · 1"]);

  // Выбор лежит в браузере и переживает перезагрузку — вместе с видом.
  expect(JSON.parse(await stored(page, "kizuna-board-filter"))).toEqual([{ field: "who", op: "=", values: ["Аня"] }]);
  await page.reload();
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  await expect(page.locator("#board-filter")).toBeVisible();
  expect(await conditionsOf(page)).toEqual(["Человек = Аня"]);
  await expect(page.locator("#board-flat .g-row .board-title")).toHaveText(["Дело Ани для фильтра", "Общее дело для фильтра", "Закрытое дело Ани"]);
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

test("«Статус = открыто» прячет «Закрыто» — колонку доски и раздел списка; «Статус = закрыто» оставляет только закрытые", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Открытое дело статуса");
  await closeDeed(request, await deed(request, "Закрытое дело статуса"));
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  await expect(page.locator(".board-done-column")).toBeVisible();

  await addCondition(page, "status", "open");
  expect(await conditionsOf(page)).toEqual(["Статус = открыто"]);
  // Колонки «Закрыто» нет вовсе, а не пустая; открытое дело на месте.
  await expect(page.locator(".board-done-column")).toHaveCount(0);
  await expect.poll(() => openTitles(page)).toEqual(["Открытое дело статуса"]);
  await expect(page.locator("#board-segments .board-segment").first()).not.toContainText("Закрыто");
  await page.locator('#board-view [data-view="list"]').click();
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 1"]);
  await expect(page.locator("#board-flat .g-sec.done, #board-flat .g-row.closed")).toHaveCount(0);

  // «Статус = закрыто»: остаются только закрытые; колонки человека при группировке по «Колонке» стоят пустые — в них бросают.
  await condition(page, 0).locator(".board-vals-btn").click();
  await condition(page, 0).locator('.board-vals-pop input[value="done"]').check();
  await condition(page, 0).locator('.board-vals-pop input[value="open"]').uncheck();
  await page.keyboard.press("Escape");
  expect(await conditionsOf(page)).toEqual(["Статус = закрыто"]);
  await expect(page.locator("#board-flat .g-row .board-title")).toHaveText(["Закрытое дело статуса"]);
  await expect(page.locator("#board-flat .g-sec")).toHaveText(["Дела · 0", "Закрыто · 1"]);
  await page.locator('#board-view [data-view="board"]').click();
  await expect(page.locator(".board-done-column .board-card.closed")).toHaveCount(1);
  await expect(columnByName(page, "Дела")).toBeVisible();
  await expect(columnByName(page, "Дела").locator(".board-card")).toHaveCount(0);

  // «≠ закрыто» — то же, что «= открыто»: «Закрыто» пропала.
  await page.locator('#board-filter [data-part="op"]').selectOption("!=");
  await expect(page.locator(".board-done-column")).toHaveCount(0);
  await expect.poll(() => openTitles(page)).toEqual(["Открытое дело статуса"]);
  await reset(request);
});

test("условия: значения одной плашки — «или», плашки между собой — «и», «≠» — «ни одно из»; у закрытого дела «День» — день закрытия", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Сегодняшнее дело Ани", { due: day(0), people: ["Аня"] });
  await deed(request, "Завтрашнее дело Ани", { due: day(1), people: ["Аня"] });
  await deed(request, "Сегодняшнее дело Бориса", { due: day(0), people: ["Борис"] });
  await deed(request, "Просроченное дело Бориса", { due: day(-3), people: ["Борис"] });
  await deed(request, "Дело на потом", { due: day(20) });
  // Закрыто сегодня, срок был завтра: под фильтром «сегодня» оно в «Закрыто», ведь закрыто сегодня.
  await closeDeed(request, await deed(request, "Закрытое сегодня досрочно", { due: day(1) }));
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  const titles = () => openTitles(page).then((list) => list.sort());

  await addCondition(page, "day", "today");
  expect(await conditionsOf(page)).toEqual(["День = сегодня"]);
  await expect.poll(titles).toEqual(["Сегодняшнее дело Ани", "Сегодняшнее дело Бориса"]);
  await expect.poll(() => doneTitles(page)).toEqual(["Закрытое сегодня досрочно"]);
  // Вторая галочка в той же плашке — «или»: сегодняшнее и завтрашнее. Плашка читается «сегодня или завтра»,
  // а тихое «и» между плашками не нужно: плашка одна.
  await tickValues(page, 0, ["tomorrow"]);
  expect(await conditionsOf(page)).toEqual(["День = сегодня или завтра"]);
  await expect(page.locator("#board-filter .board-vals-btn .board-or")).toHaveText(["или"]);
  await expect(page.locator("#board-filter .board-and")).toHaveCount(0);
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  await expect.poll(titles).toEqual(["Завтрашнее дело Ани", "Сегодняшнее дело Ани", "Сегодняшнее дело Бориса"]);
  // Другое поле — другая плашка, и между плашками стоит тихое «и»: из этих — только дела Ани.
  await addCondition(page, "who", "Аня");
  expect(await conditionsOf(page)).toEqual(["День = сегодня или завтра", "Человек = Аня"]);
  await expect(page.locator("#board-filter .board-and")).toHaveText(["и"]);
  await expect(page.locator("#board-filter .board-or")).toHaveCount(1);
  await expect.poll(titles).toEqual(["Завтрашнее дело Ани", "Сегодняшнее дело Ани"]);
  await expect.poll(() => doneTitles(page)).toEqual([]);
  await expect(filterToggle(page)).toHaveText("Фильтр · 2");

  // Поле с тем же оператором второй плашкой не заводится: «День» в новой плашке — значения идут в
  // стоящую, и её список открыт. Ничего не пропадает молча, а «или» остаётся внутри одной плашки.
  await page.locator("#board-filter .board-cond-add").click();
  await condition(page, 2).locator('[data-part="field"]').selectOption("day");
  await expect(page.locator("#board-filter .board-cond")).toHaveCount(2);
  await expect(condition(page, 0).locator(".board-vals-pop")).toBeVisible();
  await tickValues(page, 0, ["late"]);
  expect(await conditionsOf(page)).toEqual(["День = сегодня или завтра или просрочено", "Человек = Аня"]);

  // «≠» — «ни одно из»: без Ани остаются дело Бориса и дело без человека; добавили Бориса — только без человека.
  await page.locator("#board-filter .board-filter-clear").click();
  await addCondition(page, "who", "Аня", "!=");
  expect(await conditionsOf(page)).toEqual(["Человек ≠ Аня"]);
  await expect.poll(titles).toEqual(["Дело на потом", "Просроченное дело Бориса", "Сегодняшнее дело Бориса"]);
  await tickValues(page, 0, ["Борис"]);
  expect(await conditionsOf(page)).toEqual(["Человек ≠ Аня или Борис"]);
  await expect.poll(titles).toEqual(["Дело на потом"]);
  await condition(page, 0).locator(".board-vals-btn").click();
  await expect(condition(page, 0).locator(".board-vals-cap")).toHaveText("Ни одно из отмеченных");
  await page.keyboard.press("Escape");
  // «Пусто» у человека — дела, где никто не назван; «пусто или Аня» — одна плашка с двумя значениями.
  await page.locator("#board-filter .board-filter-clear").click();
  await addCondition(page, "who", "__none");
  await expect.poll(titles).toEqual(["Дело на потом"]);
  await tickValues(page, 0, ["Аня"]);
  expect(await conditionsOf(page)).toEqual(["Человек = пусто или Аня"]);
  await expect(condition(page, 0).locator(".board-vals-btn .board-or")).toHaveCount(1);
  await expect.poll(titles).toEqual(["Дело на потом", "Завтрашнее дело Ани", "Сегодняшнее дело Ани"]);
  // Выбор лежит в браузере новым форматом — значения списком, в том порядке, как выбраны.
  expect(JSON.parse(await stored(page, "kizuna-board-filter"))).toEqual([{ field: "who", op: "=", values: ["__none", "Аня"] }]);
  await reset(request);
});

test("список значений плашки управляется с клавиатуры: Enter открывает, пробел отмечает, Escape, Tab и щелчок мимо закрывают", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Сегодняшнее дело клавиатуры", { due: day(0) });
  await deed(request, "Просроченное дело клавиатуры", { due: day(-1) });
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  await addCondition(page, "day", "today");
  const chip = condition(page, 0);
  const button = chip.locator(".board-vals-btn");
  const pop = chip.locator(".board-vals-pop");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(pop).toBeHidden();
  // Enter на кнопке открывает список, Tab идёт в него: первая галочка — «просрочено».
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(pop).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(chip.locator('.board-vals-pop input[value="late"]')).toBeFocused();
  // Пробел отмечает: плашка читается новым значением, дело подтянулось, список открыт, фокус на той же галочке.
  await page.keyboard.press("Space");
  expect(await conditionsOf(page)).toEqual(["День = сегодня или просрочено"]);
  await expect.poll(() => openTitles(page)).toHaveLength(2);
  await expect(chip.locator('.board-vals-pop input[value="late"]')).toBeFocused();
  await expect(pop).toBeVisible();
  // Escape закрывает список и возвращает фокус на кнопку.
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(button).toBeFocused();
  // Shift+Tab уводит фокус из плашки — и список закрывается вместе с уходом.
  await page.keyboard.press("Enter");
  await expect(pop).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(pop).toBeHidden();
  // Щелчок мимо закрывает тоже; повторный щелчок по кнопке закрывает и открывает.
  await button.click();
  await expect(pop).toBeVisible();
  await page.locator("#board .page-heading h2").click();
  await expect(pop).toBeHidden();
  await button.click();
  await expect(pop).toBeVisible();
  await button.click();
  await expect(pop).toBeHidden();
  // Список открыт только у одной плашки за раз.
  await addCondition(page, "who", "__none");
  await condition(page, 0).locator(".board-vals-btn").click();
  await condition(page, 1).locator(".board-vals-btn").click();
  await expect(condition(page, 0).locator(".board-vals-pop")).toBeHidden();
  await expect(condition(page, 1).locator(".board-vals-pop")).toBeVisible();
  await reset(request);
});

test("фильтр из прежних версий читается: два «День =» — одна плашка «сегодня или просрочено», два «≠» — «ни одно из»", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Сегодняшнее дело прежнего фильтра", { due: day(0) });
  await deed(request, "Просроченное дело прежнего фильтра", { due: day(-2) });
  await deed(request, "Дело на завтра прежнего фильтра", { due: day(1) });
  await page.goto("/#board");
  // Так фильтр лежал в браузере раньше: по условию на значение.
  await page.evaluate(() => localStorage.setItem("kizuna-board-filter", JSON.stringify([
    { field: "day", op: "=", value: "today" },
    { field: "day", op: "=", value: "late" },
  ])));
  await page.reload();
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  expect(await conditionsOf(page)).toEqual(["День = сегодня или просрочено"]);
  await expect.poll(() => openTitles(page)).toHaveLength(2);
  // Первое же изменение кладёт фильтр в браузер новым форматом.
  await tickValues(page, 0, ["tomorrow"]);
  await expect.poll(() => openTitles(page)).toHaveLength(3);
  expect(JSON.parse(await stored(page, "kizuna-board-filter"))).toEqual([{ field: "day", op: "=", values: ["today", "late", "tomorrow"] }]);

  await page.evaluate(() => localStorage.setItem("kizuna-board-filter", JSON.stringify([
    { field: "day", op: "!=", value: "late" },
    { field: "day", op: "!=", value: "tomorrow" },
  ])));
  await page.reload();
  expect(await conditionsOf(page)).toEqual(["День ≠ просрочено или завтра"]);
  await expect.poll(() => openTitles(page)).toEqual(["Сегодняшнее дело прежнего фильтра"]);
  await reset(request);
});

test("пустые группы на доске не появляются сами — ни без фильтра, ни с ним; колонки человека остаются, заведённые группы тоже", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Сегодняшнее дело группы", { due: day(0) });
  await deed(request, "Завтрашнее дело группы", { due: day(1) });
  await request.post("/api/board/columns", { data: { name: "Пустая" } });
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.goto("/#board");
  await arrange(page, "board", ["day"]);
  const names = () => page.locator("#board-columns .board-column:not(.ghost) .board-col-name").allTextContents();
  // Без фильтра стоят только дни, где есть дела, — остальные человек заводит сам.
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "завтра"]);
  await addCondition(page, "day", "today");
  await expect.poll(names).toEqual(["Закрыто", "сегодня"]);
  // Заведённая колонка остаётся и под фильтром, хотя дел в ней сейчас нет: она своя, а не автоматическая.
  await addGroupColumn(page, "на неделе");
  await expect.poll(names).toEqual(["Закрыто", "сегодня", "на неделе"]);
  await expect(page.locator('.board-column.group[data-group="day:week"] .board-card')).toHaveCount(0);
  // Список по человеку с тем же фильтром: пустых групп нет, остались те, где есть дело.
  await arrange(page, "board", ["who"]);
  await expect.poll(names).toEqual(["Закрыто", "Без человека"]);
  // По «Колонке» пустая колонка человека остаётся, хоть в ней сейчас ничего не подходит.
  await arrange(page, "board", ["col"]);
  await expect.poll(names).toEqual(["Закрыто", "Дела", "Пустая"]);
  await expect(columnByName(page, "Пустая").locator(".board-add-button")).toHaveCount(1);
  await reset(request);
});

test("плашка условия: значение, которого больше нет, остаётся видно; испорченный фильтр в браузере — умолчание", async ({ page, request }) => {
  await reset(request);
  await deed(request, "Дело для испорченного фильтра");
  await page.goto("/#board");
  // Человека, которого нет среди дел, условие не подменяет молча: плашка на месте, дел под неё нет.
  await page.evaluate(() => localStorage.setItem("kizuna-board-filter", JSON.stringify([{ field: "who", op: "=", values: ["Ушедший", "Тоже ушёл"] }, { field: "nope", op: "=", values: ["x"] }])));
  await page.reload();
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  expect(await conditionsOf(page)).toEqual(["Человек = Ушедший или Тоже ушёл"]);
  await expect.poll(() => openTitles(page)).toEqual([]);
  // Испорченное значение не ломает доску: как в первый заход, «сегодня».
  await page.evaluate(() => localStorage.setItem("kizuna-board-filter", "{oops"));
  await page.reload();
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  expect(await conditionsOf(page)).toEqual(["День = сегодня или просрочено"]);
  await expect.poll(() => openTitles(page)).toEqual(["Дело для испорченного фильтра"]);
  // Черновик — «+ условие» без значений — ничего не отбирает и в браузер не уходит.
  await page.locator("#board-filter .board-filter-clear").click();
  await page.locator("#board-filter .board-cond-add").click();
  await expect(page.locator("#board-filter .board-cond .board-vals-btn.is-empty")).toHaveCount(1);
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
  // Приглашения нет ни у «Закрыто», ни у призрачной «+ Колонки» (у неё свой, обычный).
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

  // По дню: слова у каждой группы свои, а срок у созданного дела — срок группы. Пустые дни —
  // «завтра», «на неделе», «позже», «без срока» — человек завёл сам.
  await arrange(page, "board", ["day"], { day: ["tomorrow", "week", "later", "none"] });
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
  await expect(whoLane("Аня").locator(".board-add-button")).toHaveText("+ Дело — Аня");
  await expect(whoLane("").locator(".board-add-button")).toHaveText("+ Дело без человека");
  await create(whoLane("Аня"), "Сверить макет");
  const people = async (raw) => (await (await request.get(`/api/captures/${await idByRaw(request, raw)}`)).json()).entry.interpretation.classification.entities.people;
  expect((await people("Сверить макет"))[0]).toBe("Аня");
  await create(whoLane(""), "Убрать на столе");
  expect(await people("Убрать на столе")).toEqual([]);

  // По проекту: проект дела — как у колонки; «Без проекта» — просто дело.
  await arrange(page, "board", ["proj"]);
  const projLane = (name) => page.locator(`.board-column.group[data-group="proj:${name}"]`);
  await expect(projLane("Hub").locator(".board-add-button")).toHaveText("+ Дело — Hub");
  await expect(projLane("").locator(".board-add-button")).toHaveText("+ Дело без проекта");
  await create(projLane("Hub"), "Собрать релиз");
  const projects = async (raw) => (await (await request.get(`/api/captures/${await idByRaw(request, raw)}`)).json()).entry.interpretation.classification.entities.projects;
  expect(await projects("Собрать релиз")).toEqual(["Hub"]);

  // «Откуда»: срок и источник так не назначить — приглашения нет (а «+ Колонка» в конце ряда — другая кнопка).
  await arrange(page, "board", ["src"]);
  await expect(page.locator(".board-column:not(.ghost) .board-add-button")).toHaveCount(0);
  await reset(request);
});

// Подзадачи. «Подзадачи: Показывать» (умолчание) выносит их на доску и в список
// отдельными карточками, как дела, с подписью «↳ родитель»; у родителя — полоска и
// метка «0/1» (сделано/всего), число даёт сервер. «Скрывать» оставляет у родителя одну
// полоску с числом, самих подзадач на доске нет.
const subOf = async (request, parentId, title) => (await (await request.post(`/api/captures/${parentId}/subtasks`, { data: { title } })).json()).entry;
const closeTask = async (request, entry) => {
  for (const projection of entry.projections.filter((item) => item.type === "task")) await request.post(`/api/projections/${projection.id}/complete`, { data: {} });
};
// Цвет «сделано» из токена, а не зашитое число: метка «1/1» красится им же.
const greenOf = (page) => page.evaluate(() => {
  const probe = document.createElement("i");
  probe.style.color = "var(--green)";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
});
const colorOf = (page, token) => page.evaluate((name) => {
  const probe = document.createElement("i");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, token);
// Карточка или строка по названию: подпись «↳ родитель» у подзадачи повторяет название
// родителя, поэтому искать по тексту всей карточки нельзя — только по самому названию.
const titled = (page, selector, title) => page.locator(selector).filter({ has: page.locator(".board-title", { hasText: new RegExp(`^${title}$`) }) });
// Закрыта ли подзадача на сервере: все её задачи отмечены.
const closedOnServer = async (request, id) => {
  const entry = (await (await request.get(`/api/captures/${id}`)).json()).entry;
  const tasks = entry.projections.filter((item) => item.type === "task");
  return tasks.length > 0 && tasks.every((item) => item.completion?.completed);
};
// Сегменты переключателя «Подзадачи» в строке фильтра и запрос доски, который он посылает.
const subsToggle = (page) => page.locator("#board-filter .board-subs");
const chooseSubs = async (page, name) => {
  await openFilter(page);
  await subsToggle(page).getByRole("button", { name }).click();
};
const boardAsked = (page, withSubtasks) => page.waitForRequest((asked) => {
  const url = new URL(asked.url());
  return url.pathname === "/api/board" && (url.searchParams.get("subtasks") === "1") === withSubtasks;
});

test("«Показывать»: подзадача стоит на доске своей карточкой с подписью «↳ родитель», у родителя полоска и «0/1»; счётчики считают все карточки; в списке то же", async ({ page, request }) => {
  await reset(request);
  const parentId = await deed(request, "Предварительно взять блокнот");
  await deed(request, "Проверить логи Hub");
  const child = await subOf(request, parentId, "Выбрать блокнот в клетку");
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  const cards = page.locator("#board-columns .board-card");
  const parent = titled(page, "#board-columns .board-card", "Предварительно взять блокнот");
  const step = titled(page, "#board-columns .board-card", "Выбрать блокнот в клетку");

  // Три карточки: два дела и подзадача. Подзадача — не строка внутри родителя: у неё свой кружок,
  // своё название и подпись родителя под ним — мелкая метка в том же виде, что срок и прочие.
  await expect(cards).toHaveCount(3);
  await expect(cards.locator(".board-title")).toHaveText(["Предварительно взять блокнот", "Проверить логи Hub", "Выбрать блокнот в клетку"]);
  await expect(step.getByRole("button", { name: "Готово: Выбрать блокнот в клетку" })).toBeVisible();
  await expect(step.locator(".btag.parent")).toHaveText("↳ Предварительно взять блокнот");
  await expect(page.locator("#board-columns .btag.parent")).toHaveCount(1);
  await expect(parent.locator(".btag.parent")).toHaveCount(0);
  const label = step.locator(".btag.parent");
  await expect(label).toHaveCSS("font-size", "10px");
  await expect(label).toHaveCSS("background-color", await colorOf(page, "--hairline"));
  const [titleBox, labelBox] = [await step.locator(".board-title").boundingBox(), await label.boundingBox()];
  expect(labelBox.y).toBeGreaterThan(titleBox.y + titleBox.height - 1);
  expect(labelBox.x).toBeCloseTo(titleBox.x, 0);

  // У родителя — полоска и «0/1», а строк подзадач внутри карточки нет; у подзадачи без своих подзадач полоски нет.
  await expect(parent.locator(".sub-bar")).toBeVisible();
  await expect(parent.locator(".sub-badge")).toHaveText("0/1");
  await expect(parent.locator(".sub-badge")).toHaveAccessibleName("Подзадачи: сделано 0 из 1. Открыть подзадачи");
  await expect(page.locator("#board-columns .sub-row, #board-columns .sub-check, #board-columns .sub-name")).toHaveCount(0);
  await expect(step.locator(".sub-map")).toHaveCount(0);
  await expect(page.locator("#board-columns .sub-badge")).toHaveCount(1);
  // Счётчик колонки считает все три показанные карточки.
  await expect(columnByName(page, "Дела").locator(".board-col-count")).toHaveText("3");

  // Список: те же три строки, подпись — под названием, у родителя полоска и число, счёт раздела — «3».
  await arrange(page, "list", ["col"]);
  const rows = page.locator("#board-flat .g-row");
  const stepRow = titled(page, "#board-flat .g-row", "Выбрать блокнот в клетку");
  await expect(rows).toHaveCount(3);
  await expect(rows.locator(".board-title")).toHaveText(["Предварительно взять блокнот", "Проверить логи Hub", "Выбрать блокнот в клетку"]);
  await expect(stepRow.locator(".btag.parent")).toHaveText("↳ Предварительно взять блокнот");
  const [rowTitle, rowLabel] = [await stepRow.locator(".board-title").boundingBox(), await stepRow.locator(".btag.parent").boundingBox()];
  expect(rowLabel.y).toBeGreaterThan(rowTitle.y + rowTitle.height - 1);
  await expect(titled(page, "#board-flat .g-row", "Предварительно взять блокнот").locator(".sub-badge")).toHaveText("0/1");
  await expect(page.locator("#board-flat .g-sec").first()).toContainText("· 3");
  // Группировка по дню считает те же три дела.
  await arrange(page, "list", ["day"]);
  await expect(page.locator("#board-flat .g-sec").filter({ hasText: "сегодня" })).toContainText("· 3");

  // Закрыли подзадачу: в «Закрыто» она стоит такой же карточкой с подписью, у родителя «1/1» зелёным.
  await closeTask(request, child);
  await arrange(page, "board", ["col"]);
  const closedStep = titled(page, "#board-columns .board-card.closed", "Выбрать блокнот в клетку");
  await expect(closedStep).toHaveCount(1);
  await expect(closedStep.locator(".btag.parent")).toHaveText("↳ Предварительно взять блокнот");
  await expect(page.locator("#board-columns .board-card:not(.closed)")).toHaveCount(2);
  await expect(columnByName(page, "Дела").locator(".board-col-count")).toHaveText("2");
  await expect(page.locator("#board-columns .board-done-column .board-col-count")).toHaveText("1");
  await expect(parent.locator(".sub-badge")).toHaveText("1/1");
  await expect(parent.locator(".sub-badge")).toHaveClass(/all-done/);
  await expect(parent.locator(".sub-badge")).toHaveCSS("color", await greenOf(page));
  await arrange(page, "list", ["col"]);
  await expect(page.locator("#board-flat .g-row.closed")).toHaveCount(1);
  await expect(titled(page, "#board-flat .g-row.closed", "Выбрать блокнот в клетку").locator(".btag.parent")).toHaveText("↳ Предварительно взять блокнот");
  await reset(request);
});

test("метка «0/1» у родителя на доске открывает его карточку на «Подзадачах», а закрытая в карточке подзадача делает метку «1/1» зелёной и уходит своей карточкой в «Закрыто»", async ({ page, request }) => {
  await reset(request);
  const parentId = await deed(request, "Предварительно взять блокнот");
  await subOf(request, parentId, "Выбрать блокнот в клетку");
  // Длинное описание уводит «Подзадачи» за нижний край карточки: без докрутки их не видно.
  await request.post(`/api/captures/${parentId}/notes`, { data: { body: Array.from({ length: 40 }, (_, index) => `Пункт ${index + 1} заметки про блокнот`).join("\n\n") } });
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  const card = titled(page, "#board-columns .board-card", "Предварительно взять блокнот");
  const dialog = page.locator("#review-dialog");
  const section = dialog.locator("#card-subtasks");

  // По названию карточка открывается с начала: раздел «Подзадачи» ниже экрана.
  await card.locator(".board-title").click();
  await expect(section).toBeVisible();
  await expect(section.locator(".subtask-count")).toHaveText("0 / 1");
  await expect(section).not.toBeInViewport();
  // Длинную карточку читают колесом: прокрутка — в колонке содержимого.
  const scrolled = () => dialog.locator("#review").evaluate((element) => element.scrollTop);
  expect(await scrolled()).toBe(0);
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, 600);
  await expect.poll(scrolled).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // По метке — сразу на «Подзадачах»: колонка докручена, верхняя строка окна на месте.
  await card.locator(".sub-badge").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".card-title")).not.toBeInViewport();
  await expect(section).toBeInViewport({ ratio: 1 });
  await expect(section.locator(".subtask-name")).toHaveText("Выбрать блокнот в клетку");
  await expect(dialog.locator(".card-top")).toBeInViewport({ ratio: 1 });
  expect(await dialog.evaluate((element) => element.querySelector(".card-main").scrollTop)).toBe(0);

  // Подзадача закрыта кружком в карточке — метка за ней уже «1/1» и зелёная, а её карточка ушла в «Закрыто».
  await section.locator(".subtask-check").check();
  await expect(section.locator(".subtask-count")).toHaveText("1 / 1");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const badge = card.locator(".sub-badge");
  await expect(badge).toHaveText("1/1");
  await expect(badge).toHaveClass(/all-done/);
  await expect(badge).toHaveCSS("color", await greenOf(page));
  await expect(page.locator("#board-columns .board-card:not(.closed)")).toHaveCount(1);
  await expect(titled(page, "#board-columns .board-card.closed", "Выбрать блокнот в клетку")).toHaveCount(1);

  // Открыли заново по названию — читается с начала: ни прежняя докрутка, ни колесо не липнут.
  await card.locator(".board-title").click();
  await expect(section).toBeVisible();
  await expect(section).not.toBeInViewport();
  expect(await scrolled()).toBe(0);
  await page.keyboard.press("Escape");
  await reset(request);
});

test("карточка подзадачи — как у дела: название открывает её карточку, кружок закрывает и возвращает, за название её переносят в другую колонку, и это помнится", async ({ page, request }) => {
  await reset(request);
  const parentId = await deed(request, "Подготовить квартальный отчёт");
  const first = await subOf(request, parentId, "Собрать цифры по продажам");
  await subOf(request, parentId, "Свести таблицы в один файл");
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  await addColumn(page, "Ожидание");
  const home = columnByName(page, "Дела");
  const wait = columnByName(page, "Ожидание");
  const parent = titled(page, "#board-columns .board-card", "Подготовить квартальный отчёт");
  const step = titled(page, "#board-columns .board-card", "Собрать цифры по продажам");
  const dialog = page.locator("#review-dialog");
  await expect(home.locator(".board-card")).toHaveCount(3);
  await expect(step).toHaveJSProperty("draggable", true);

  // Название открывает карточку самой подзадачи, а не родителя; родитель назван в ней строкой «Подзадача дела».
  await step.locator(".board-title").click();
  await expect(dialog.locator(".card-title")).toHaveText("Собрать цифры по продажам");
  await expect(dialog.locator(".card-origin")).toContainText("Подзадача дела «Подготовить квартальный отчёт»");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Кружок закрывает подзадачу: она уходит в «Закрыто», у родителя «1/2», сам родитель остаётся открытым.
  await step.getByRole("button", { name: "Готово: Собрать цифры по продажам" }).click();
  await expect.poll(() => closedOnServer(request, first.id)).toBe(true);
  const closedStep = titled(page, "#board-columns .board-done-column .board-card", "Собрать цифры по продажам");
  await expect(closedStep).toHaveCount(1);
  await expect(parent.locator(".sub-badge")).toHaveText("1/2");
  expect(await closedOnServer(request, parentId)).toBe(false);
  // Кружок закрытой возвращает её в работу — в ту же колонку.
  await closedStep.getByRole("button", { name: "Вернуть в работу: Собрать цифры по продажам" }).click();
  await expect.poll(() => closedOnServer(request, first.id)).toBe(false);
  await expect(titled(page, "#board-columns .board-column:not(.board-done-column) .board-card", "Собрать цифры по продажам")).toHaveCount(1);
  await expect(parent.locator(".sub-badge")).toHaveText("0/2");
  await settled(page);

  // За название карточка переносится в другую колонку, как дело; перенос просит у сервера порядок по списку с подзадачами.
  const moved = page.waitForRequest((asked) => asked.url().endsWith("/api/board/move") && JSON.parse(asked.postData()).subtasks === true);
  await step.locator(".board-title").dragTo(wait.locator(".board-cards"));
  await moved;
  await expect(titled(page, "#board-columns .board-card", "Собрать цифры по продажам")).toHaveCount(1);
  await expect(wait.locator(".board-card")).toHaveCount(1);
  await expect(wait.locator(".board-title")).toHaveText("Собрать цифры по продажам");
  await expect(home.locator(".board-card")).toHaveCount(2);
  // Место помнится на сервере: после перезагрузки подзадача лежит в «Ожидание», родитель — в «Дела».
  await arrange(page, "board", ["col"]);
  await expect(wait.locator(".board-title")).toHaveText("Собрать цифры по продажам");
  await expect(home.locator(".board-title")).toHaveText(["Подготовить квартальный отчёт", "Свести таблицы в один файл"]);
  await expect(wait.locator(".btag.parent")).toHaveText("↳ Подготовить квартальный отчёт");
  await reset(request);
});

test("«Скрывать» убирает подзадачи с доски и из списка, у родителя остаются полоска и число; выбор помнится после перезагрузки, на «Сегодня» — только метка", async ({ page, request }) => {
  await reset(request);
  const parentId = await deed(request, "Подготовить квартальный отчёт");
  const first = await subOf(request, parentId, "Собрать цифры по продажам");
  await subOf(request, parentId, "Свести таблицы в один файл");
  await closeTask(request, first);
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  const card = titled(page, "#board-columns .board-card", "Подготовить квартальный отчёт");

  // По умолчанию подзадачи показываются карточками (и закрытая — в «Закрыто»); переключатель — два сегмента справа в строке фильтра.
  expect(await stored(page, "kizuna-board-subtasks")).toBeNull();
  await expect(page.locator("#board-columns .board-card:not(.closed)")).toHaveCount(2);
  await expect(page.locator("#board-columns .board-card.closed")).toHaveCount(1);
  await openFilter(page);
  await expect(subsToggle(page)).toBeVisible();
  await expect(subsToggle(page).getByRole("button")).toHaveText(["Показывать", "Скрывать"]);
  await expect(subsToggle(page).getByRole("button", { name: "Показывать" })).toHaveAttribute("aria-pressed", "true");
  await expect(subsToggle(page).getByRole("button", { name: "Скрывать" })).toHaveAttribute("aria-pressed", "false");
  // Справа, рядом с «Сегодня» и «Сбросить»: в одном хвосте строки, левее «Сегодня».
  const tail = page.locator("#board-filter .board-filter-tail");
  await expect(tail.locator(".board-subs")).toHaveCount(1);
  const [subsBox, todayBox, rowBox] = [await subsToggle(page).boundingBox(), await page.locator("#board-filter .board-filter-today").boundingBox(), await page.locator("#board-filter").boundingBox()];
  expect(subsBox.x).toBeLessThan(todayBox.x);
  expect(subsBox.x).toBeGreaterThan(rowBox.x + rowBox.width / 2);

  // «Скрывать»: подзадач на доске нет совсем, у родителя полоска и «1/2»; выбор лежит в браузере.
  const hidden = boardAsked(page, false);
  await chooseSubs(page, "Скрывать");
  await hidden;
  await expect(subsToggle(page).getByRole("button", { name: "Скрывать" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#board-columns .board-card")).toHaveCount(1);
  await expect(page.locator("#board-columns .btag.parent")).toHaveCount(0);
  await expect(card.locator(".sub-bar")).toBeVisible();
  await expect(card.locator(".sub-badge")).toHaveText("1/2");
  await expect(card.locator(".sub-bar-fill")).toHaveAttribute("style", /width: 50%/);
  await expect(card.locator(".sub-row")).toHaveCount(0);
  await expect(columnByName(page, "Дела").locator(".board-col-count")).toHaveText("1");
  await expect(page.locator("#board-columns .board-done-column .board-col-count")).toHaveText("0");
  expect(await stored(page, "kizuna-board-subtasks")).toBe("hide");
  // Это не условие фильтра: «Сбросить» его не трогает, а фильтр не считает.
  await addCondition(page, "day", ["today"]);
  await expect(filterToggle(page)).toHaveText("Фильтр · 1");
  await page.locator("#board-filter .board-filter-clear").click();
  await expect(filterToggle(page)).toHaveText("Фильтр");
  expect(await stored(page, "kizuna-board-subtasks")).toBe("hide");
  await expect(page.locator("#board-columns .board-card")).toHaveCount(1);

  // После перезагрузки — то же: подзадач нет, «Скрывать» нажато.
  await page.reload();
  await expect(card.locator(".sub-bar")).toBeVisible();
  await expect(page.locator("#board-columns .board-card")).toHaveCount(1);
  await openFilter(page);
  await expect(subsToggle(page).getByRole("button", { name: "Скрывать" })).toHaveAttribute("aria-pressed", "true");

  // Список действует так же: у строки дела полоска и число, подзадач нет.
  await arrange(page, "list", ["col"]);
  const row = titled(page, "#board-flat .g-row", "Подготовить квартальный отчёт");
  await expect(row.locator(".sub-bar")).toBeVisible();
  await expect(row.locator(".sub-badge")).toHaveText("1/2");
  await expect(page.locator("#board-flat .g-row")).toHaveCount(1);
  // «Показывать» возвращает подзадачи — и в списке, и на доске, выбор снова «show»; закрытая лежит в «Закрыто».
  const shown = boardAsked(page, true);
  await chooseSubs(page, "Показывать");
  await shown;
  await expect(page.locator("#board-flat .g-row")).toHaveCount(3);
  await expect(page.locator("#board-flat .g-row:not(.closed) .board-title")).toHaveText(["Подготовить квартальный отчёт", "Свести таблицы в один файл"]);
  await expect(titled(page, "#board-flat .g-row.closed", "Собрать цифры по продажам").locator(".btag.parent")).toHaveText("↳ Подготовить квартальный отчёт");
  expect(await stored(page, "kizuna-board-subtasks")).toBe("show");
  await arrange(page, "board", ["col"]);
  await expect(page.locator("#board-columns .board-card")).toHaveCount(3);

  // «Сегодня» — только метка, подзадач отдельными строками нет и при «показывать».
  await page.goto("/");
  // Вкладка «День» открыта днём и закрыта вечером: повторный щелчок по открытой сворачивает ящик.
  const dayTab = page.getByRole("tab", { name: /^День/ });
  if ((await dayTab.getAttribute("aria-selected")) !== "true") await dayTab.click();
  const today = page.locator("#todo .entry").filter({ hasText: "Подготовить квартальный отчёт" });
  await expect(today.locator(".sub-badge")).toHaveText("1/2");
  await expect(page.locator("#todo .entry").filter({ hasText: "Свести таблицы в один файл" })).toHaveCount(0);
  await expect(page.locator("#todo .sub-map, #todo .sub-bar, #todo .btag.parent")).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem("kizuna-board-subtasks"));
  await reset(request);
});

test("переключатель «Подзадачи» — сегменты, как у «Вида»: активный залит тёмным со светлым текстом; клик перечитывает доску — карточки подзадач уходят и возвращаются без перезагрузки страницы, выбор помнится", async ({ page, request }) => {
  await reset(request);
  const parentId = await deed(request, "Подготовить квартальный отчёт");
  await subOf(request, parentId, "Собрать цифры по продажам");
  await subOf(request, parentId, "Свести таблицы в один файл");
  await page.goto("/#board");
  await arrange(page, "board", ["col"]);
  await openFilter(page);
  const show = subsToggle(page).getByRole("button", { name: "Показывать" });
  const hide = subsToggle(page).getByRole("button", { name: "Скрывать" });
  const cards = page.locator("#board-columns .board-card");
  const view = page.locator('#board-view button[aria-pressed="true"]');
  const paint = (locator) => locator.evaluate((element) => { const css = getComputedStyle(element); return [css.backgroundColor, css.color]; });
  const transparent = "rgba(0, 0, 0, 0)";

  // Активный сегмент выглядит, как активный вид: тёмная заливка и светлый текст; неактивный без заливки.
  await expect(show).toHaveAttribute("aria-pressed", "true");
  await expect(hide).toHaveAttribute("aria-pressed", "false");
  expect(await paint(show)).toEqual(await paint(view));
  expect(await paint(show)).toEqual([await colorOf(page, "--ink"), await colorOf(page, "--paper")]);
  expect((await paint(hide))[0]).toBe(transparent);
  await expect(cards).toHaveCount(3);

  // Клик перечитывает доску: «Скрывать» просит её без подзадач, «Показывать» — с ними; страница не перезагружается.
  await page.evaluate(() => { window.__sameDocument = true; });
  const withoutSubs = boardAsked(page, false);
  await hide.click();
  await withoutSubs;
  await expect(hide).toHaveAttribute("aria-pressed", "true");
  await expect(show).toHaveAttribute("aria-pressed", "false");
  expect(await paint(hide)).toEqual(await paint(view));
  expect((await paint(show))[0]).toBe(transparent);
  await expect(cards).toHaveCount(1);
  await expect(page.locator("#board-columns .board-card .sub-bar")).toBeVisible();
  await expect(page.locator("#board-columns .board-card .sub-badge")).toHaveText("0/2");
  expect(await stored(page, "kizuna-board-subtasks")).toBe("hide");
  const withSubs = boardAsked(page, true);
  await show.click();
  await withSubs;
  await expect(show).toHaveAttribute("aria-pressed", "true");
  await expect(cards).toHaveCount(3);
  await expect(page.locator("#board-columns .btag.parent")).toHaveText(["↳ Подготовить квартальный отчёт", "↳ Подготовить квартальный отчёт"]);
  expect(await stored(page, "kizuna-board-subtasks")).toBe("show");
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  await reset(request);
});
