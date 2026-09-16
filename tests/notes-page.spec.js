import { test, expect } from "@playwright/test";

const reset = (request) => request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
const makePage = async (request, title, parent) => (await (await request.post("/api/pages", { data: parent ? { title, parent } : { title } })).json()).page;

test("«Заметки» стоят в шапке вместо «Обзора», а обзор открывается по адресу", async ({ page, request }) => {
  await reset(request);
  await page.goto("/");
  await expect(page.locator('nav a[href="#notes"]')).toHaveText("Заметки");
  await expect(page.locator('nav a[href="#reports"]')).toHaveCount(0);
  await page.locator('nav a[href="#notes"]').click();
  await expect(page.locator("#notes")).toBeVisible();
  await expect(page.locator(".notes-side")).toContainText("Входящие");
  await page.goto("/#reports");
  await expect(page.locator("#reports")).toBeVisible();
});

test("новая страница: название, текст со ссылкой, место в дереве и обратная ссылка", async ({ page, request }) => {
  await reset(request);
  const home = await makePage(request, "Кизуна");
  await page.goto("/#notes");
  await page.locator(".notes-side-add[aria-label='Новая страница']").click();
  const title = page.locator(".notes-title");
  await expect(title).toBeFocused();
  await page.keyboard.type("Планы на осень");
  await page.keyboard.press("Enter");
  await expect(page.locator(".notes-markdown")).toBeFocused();
  // После «[[» — страницы на выбор: название набирать целиком не нужно.
  await page.keyboard.type("Смотри [[Кизу");
  const suggest = page.locator(".link-menu:not([hidden])");
  await expect(suggest.locator(".link-option").first()).toContainText("Кизуна");
  await page.keyboard.press("Enter");
  await expect(suggest).toHaveCount(0);
  await expect(page.locator(".notes-markdown")).toHaveText("Смотри [[Кизуна]]");
  // Текст сохраняется сам — версия появляется в полосе над страницей.
  await expect(page.locator("#notes-version")).toContainText("версия 2", { timeout: 5000 });
  await expect(page.locator(".notes-side .notes-row", { hasText: "Планы на осень" })).toBeVisible();
  // Сохранение будит журнал, и страница обновляется в фоне — но поле не
  // теряет фокус: набор продолжается с того же места.
  await page.waitForTimeout(600);
  await expect(page.locator(".notes-markdown")).toBeFocused();
  await page.keyboard.type(" и дальше");
  await expect(page.locator(".notes-markdown")).toHaveText("Смотри [[Кизуна]] и дальше");

  // Место — через выбор: страница уходит внутрь «Кизуны».
  await page.locator(".notes-prop-button").click();
  await page.locator(".notes-picker-input").fill("Кизу");
  await page.locator(".notes-picker-row", { hasText: "Кизуна" }).first().click();
  await expect(page.locator(".notes-crumbs")).toContainText("Кизуна");
  await expect(page.locator(".notes-props")).toContainText("указано");

  // Ссылка в готовом тексте ведёт на страницу, а там видно, кто на неё ссылается.
  await title.click();
  await page.locator(".notes-markdown .md-wikilink", { hasText: "Кизуна" }).click();
  await expect(page).toHaveURL(new RegExp(`page=${home.id}`));
  await expect(title).toHaveText("Кизуна");
  const backlinks = page.locator(".notes-section", { hasText: "Ссылаются сюда" });
  await expect(backlinks).toContainText("Планы на осень");
  await expect(page.locator(".notes-children")).toContainText("Планы на осень");
});

test("заметка с «Сегодня» ждёт во «Входящих» и раскладывается по подсказке", async ({ page, request }) => {
  await reset(request);
  const release = await makePage(request, "Релиз 1.4");
  const { entry } = await (await request.post("/api/captures", { data: { raw: "Про релиз 1.4: changelog и круги" } })).json();
  await page.goto("/#notes?view=inbox");
  const row = page.locator(".notes-inbox-row", { hasText: "Про релиз 1.4" });
  await expect(row).toBeVisible();
  await expect(page.locator(".notes-row", { hasText: "Входящие" }).locator(".notes-count")).toHaveText("1");
  await row.getByRole("button", { name: "В «Релиз 1.4»" }).click();
  await expect(page.locator(".notes-inbox")).toContainText("Пусто — всё разложено.");

  // Та же запись в карточке ведёт на свою страницу.
  await page.goto(`/#today?open=${entry.id}`);
  await expect(page.locator("#review-dialog")).toBeVisible();
  await page.locator("#review-dialog .card-page-link").click();
  await expect(page.locator("#review-dialog")).toBeHidden();
  await expect(page.locator(".notes-crumbs")).toContainText("Релиз 1.4");
  await expect(page).toHaveURL(new RegExp(`page=${entry.id}`));
  expect(release.id).toBeTruthy();
});

test("строка заметки уходит делом на «Доску» и отмечается, когда дело закрыли", async ({ page, request }) => {
  await reset(request);
  const note = await makePage(request, "Что сделать до релиза");
  await request.post(`/api/captures/${note.id}/notes`, { data: { body: "План:\n- [ ] Позвонить в банк\n- [ ] Просто пункт" } });
  await page.goto(`/#notes?page=${note.id}`);
  const line = page.locator(".notes-markdown .md-line", { hasText: "Позвонить в банк" });
  await line.hover();
  await page.locator(".notes-deed-button").click();
  await expect(line).toHaveAttribute("data-deed", /дело · Доска · Входящие/, { timeout: 10000 });
  // Вторая строка осталась простым чекбоксом.
  await expect(page.locator(".notes-markdown .md-line", { hasText: "Просто пункт" })).not.toHaveClass(/is-deed/);

  await page.goto("/#board");
  await expect(page.locator(".board-card", { hasText: "Позвонить в банк" })).toBeVisible();

  const detail = await (await request.get(`/api/pages/${note.id}`)).json();
  await request.post(`/api/projections/${detail.deeds[0].projectionIds[0]}/complete`);
  await page.goto(`/#notes?page=${note.id}`);
  const done = page.locator(".notes-markdown .md-line", { hasText: "Позвонить в банк" });
  await expect(done).toHaveAttribute("data-deed", "дело · сделано");
  await expect(done.locator(".md-checkbox")).toHaveClass(/md-checkbox-done/);

  // Чекбокс в самой заметке открывает дело обратно — и на «Доске» тоже.
  await done.locator(".md-checkbox").click();
  await expect(done).toHaveAttribute("data-deed", /дело · Доска/);
  await expect.poll(async () => (await (await request.get(`/api/pages/${note.id}`)).json()).deeds[0].state).toBe("open");
});

test("«Все заметки»: галерея и сохранение вида базой", async ({ page, request }) => {
  await reset(request);
  await makePage(request, "Shape Up", "project:Книги");
  await makePage(request, "How to Take Smart Notes", "project:Книги");
  await makePage(request, "Кизуна");
  await page.goto("/#notes?view=all");
  await expect(page.locator(".notes-table tbody tr")).toHaveCount(3);
  await page.locator(".notes-base-tab", { hasText: "Галерея" }).click();
  await expect(page.locator(".notes-card")).toHaveCount(3);
  await page.locator(".notes-base-select[aria-label='Проект']").selectOption("Книги");
  await expect(page.locator(".notes-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Сохранить как базу" }).click();
  const title = page.locator(".notes-title");
  await expect(title).toBeFocused();
  await page.keyboard.type("Чтение");
  await page.keyboard.press("Enter");
  await expect(page.locator(".notes-side .notes-row", { hasText: "Чтение" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".notes-card")).toHaveCount(2);
  await expect(page.locator(".notes-base-tab[aria-pressed='true']")).toHaveText("Галерея");
  // Узел проекта в дереве собирает его заметки.
  await page.locator(".notes-row", { hasText: "Книги" }).locator(".notes-link").click();
  await expect(page.locator(".notes-children")).toContainText("Shape Up");
});

test("блоки страницы сворачиваются и остаются свёрнутыми", async ({ page, request }) => {
  await reset(request);
  const parent = await makePage(request, "Доступы Андрея");
  await makePage(request, "Доступы Андрея с ГитЛабом", parent.id);
  await request.post("/api/captures", { data: { raw: "Проверить [[Доступы Андрея]] до пятницы" } });
  await page.goto(`/#notes?page=${parent.id}`);
  const props = page.locator(".notes-props-block");
  const children = page.locator(".notes-children");
  const backlinks = page.locator(".notes-backlinks");
  await expect(props.locator(".notes-props")).toBeVisible();
  await expect(children.locator(".notes-page-row")).toBeVisible();

  await props.locator(".notes-fold").click();
  await expect(props.locator(".notes-props")).toBeHidden();
  // Свёрнутые свойства оставляют строку с главным: место и тип.
  await expect(props.locator(".notes-props-summary")).toHaveText("Корень · Заметка");
  await children.locator(".notes-fold").click();
  await backlinks.locator(".notes-fold").click();
  await expect(children.locator(".notes-page-row")).toBeHidden();
  await expect(backlinks.locator(".notes-ref")).toBeHidden();
  await expect(backlinks.locator(".notes-fold")).toHaveAttribute("aria-expanded", "false");

  await page.reload();
  await expect(page.locator(".notes-props-block .notes-props")).toBeHidden();
  await expect(page.locator(".notes-children .notes-page-row")).toBeHidden();
  await expect(page.locator(".notes-backlinks .notes-ref")).toBeHidden();
  await page.locator(".notes-backlinks .notes-fold").click();
  await expect(page.locator(".notes-backlinks .notes-ref")).toContainText("Проверить");
  await page.locator(".notes-props-block .notes-fold").click();
  await page.locator(".notes-children .notes-fold").click();
  await expect(page.locator(".notes-props-block .notes-props")).toBeVisible();
});

test("в карточке записи «[[» подсказывает страницы и заводит новую", async ({ page, request }) => {
  await reset(request);
  await makePage(request, "Релиз 1.4");
  const { entry } = await (await request.post("/api/captures", { data: { raw: "Мысль про интерфейс" } })).json();
  await page.goto(`/#today?open=${entry.id}`);
  const field = page.locator("#card-body-editor");
  await field.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[рел");
  const suggest = page.locator(".link-menu:not([hidden])");
  await expect(suggest.locator(".link-option").first()).toContainText("Релиз 1.4");
  await page.keyboard.press("Enter");
  await expect(field).toContainText("Мысль про интерфейс [[Релиз 1.4]]");

  // Нужной страницы нет — последний пункт заводит её и ставит ссылку.
  await page.keyboard.type(" и [[Планы на осень");
  await expect(suggest.locator(".link-option").last()).toContainText("Новая страница «Планы на осень»");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await suggest.locator(".link-option").last().click();
  await expect(field).toContainText("и [[Планы на осень]]");
  await expect.poll(async () => (await (await request.get("/api/pages")).json()).pages.some((item) => item.title === "Планы на осень")).toBe(true);
});

test("страницы в дереве перетаскиваются: внутрь, рядом, в корень и в проект", async ({ page, request }) => {
  await reset(request);
  const home = await makePage(request, "Кизуна");
  const release = await makePage(request, "Релиз 1.4");
  const voice = await makePage(request, "Голос");
  await makePage(request, "Shape Up", "project:Книги");
  const pages = async () => (await (await request.get("/api/pages")).json()).pages;
  const find = async (id) => (await pages()).find((item) => item.id === id);
  const row = (id) => page.locator(`.notes-side .notes-row[data-key="${id}"]`);
  await page.goto("/#notes?view=all");
  await expect(row(voice.id)).toBeVisible();

  // На середину строки — внутрь страницы.
  await row(voice.id).dragTo(row(home.id), { targetPosition: { x: 60, y: 15 } });
  await expect.poll(async () => (await find(voice.id)).parentKey).toBe(home.id);
  await expect(page.locator(".notes-side .notes-group").locator(`.notes-row[data-key="${voice.id}"]`)).toBeVisible();

  // К верхнему краю — рядом, перед страницей.
  const rootTitles = page.locator(".notes-side .notes-tree[aria-label='Страницы'] > .notes-row .notes-link-title");
  await expect(rootTitles).toHaveText(["Книги", "Кизуна", "Релиз 1.4"]);
  await row(release.id).dragTo(row(home.id), { targetPosition: { x: 60, y: 2 } });
  await expect(rootTitles).toHaveText(["Книги", "Релиз 1.4", "Кизуна"]);
  await page.reload();
  await expect(rootTitles).toHaveText(["Книги", "Релиз 1.4", "Кизуна"]);

  // На заголовок «Страницы» — в корень; на проект — в проект.
  await row(voice.id).dragTo(page.locator(".notes-side-head", { hasText: "Страницы" }));
  await expect.poll(async () => (await find(voice.id)).parentKey).toBe(null);
  await row(voice.id).dragTo(page.locator('.notes-side .notes-row[data-key="project:Книги"]'), { targetPosition: { x: 60, y: 15 } });
  await expect.poll(async () => { const item = await find(voice.id); return `${item.parentKey} ${item.project}`; }).toBe("project:Книги Книги");
});

// Удаление — из полосы над страницей, как у записи в карточке: сразу и с
// «Вернуть» в уведомлении. Страница внутри удалённой не пропадает.
test("страница удаляется из полосы над ней и возвращается из уведомления", async ({ page, request }) => {
  await reset(request);
  const home = await makePage(request, "Дача");
  const inner = await makePage(request, "Смета на забор", home.id);
  await page.goto(`/#notes?page=${home.id}`);
  await expect(page.locator(".notes-title")).toHaveText("Дача");
  await page.locator(".notes-bar").getByRole("button", { name: "Удалить" }).click();
  const toast = page.locator("#toast");
  await expect(toast).toContainText("Страница «Дача» удалена");
  await expect(page.locator(".notes-side .notes-row", { hasText: "Дача" })).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(home.id));
  const pages = (await (await request.get("/api/pages")).json()).pages;
  expect(pages.map((item) => item.title)).not.toContain("Дача");
  expect(pages.find((item) => item.id === inner.id).parentKey).toBe("inbox");

  await toast.getByRole("button", { name: "Вернуть" }).click();
  await expect(page.locator(".notes-title")).toHaveText("Дача");
  await expect(page.locator(".notes-side .notes-row", { hasText: "Дача" })).toBeVisible();
  const back = (await (await request.get("/api/pages")).json()).pages;
  expect(back.find((item) => item.id === inner.id).parentKey).toBe(home.id);
});
