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

test("доска: «Сделано» слева, своя колонка, быстрое дело, карточка и кружок", async ({ page, request }) => {
  await reset(request);
  await page.goto("/#board");

  // Свойств и фильтра нет; над доской — вид и группировка, по умолчанию «Доска»
  // по колонкам. Слева прибита «Сделано», за ней первая колонка «Дела»
  // (заводится сервером сама) и призрачная «+ Колонка».
  await expect(page.locator("#board-props-toggle, #board-filter")).toHaveCount(0);
  await expect(page.locator("#board-view button")).toHaveText(["Доска", "Список", "Таблица"]);
  await expect(page.locator("#board-view button[aria-pressed=true]")).toHaveText("Доска");
  expect(await groupsOf(page)).toEqual(["col"]);
  await expect(page.locator(".board-column:not(.ghost) .board-col-name")).toHaveText(["Сделано", "Дела"]);
  await expect(page.locator(".board-column.inbox")).toHaveCount(0);
  await expect(page.locator(".board-column.ghost")).toBeVisible();
  await expect(page.locator(".board-column.board-done-column .board-col-name")).toHaveAttribute("href", "#done");
  // «Сделано» не тянется и без меню.
  await expect(page.locator(".board-done-column .board-col-head")).not.toHaveAttribute("draggable", "true");
  await expect(page.locator(".board-done-column .board-menu")).toHaveCount(0);
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
  await expect(card.locator(".board-who")).toHaveAttribute("title", "Анна");

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

  // Колонка тянется за заголовок: «Ожидание» встаёт перед «Дела» — но не левее «Сделано».
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
  // Колонки-группы: заголовок не тянется, меню и «+ Колонки» нет; слева по-прежнему «Сделано».
  await expect(page.locator(".board-column.group .board-menu, .board-column.group .board-col-head[draggable=true], .board-column.ghost")).toHaveCount(0);
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
  await expect(page.locator(".board-column.group .board-menu, .board-column.group .board-col-head[draggable=true], .board-column.ghost")).toHaveCount(0);
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
  await expect(page.locator("#review-dialog .card-nav-rest")).toHaveText("Доска · 2 из 3");
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
