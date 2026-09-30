import { test, expect } from "@playwright/test";
async function capture(page, raw) {
  const posted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/captures") &&
      response.request().method() === "POST",
  );
  await page.getByLabel("Новая запись").fill(raw);
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  const response = await posted;
  expect(response.status()).toBe(202);
  expect(await response.request().headerValue("prefer")).toContain(
    "respond-async",
  );
  expect(await response.request().headerValue("idempotency-key")).toMatch(
    /^capture-[A-Za-z0-9._~-]{8,128}$/,
  );
  const job = await response.json();
  await expect
    .poll(
      async () => (await (await page.request.get(job.statusUrl)).json()).state,
      { timeout: 7000 },
    )
    .toBe("succeeded");
  await expect(page.locator("#capture-notifications")).toContainText("Готово");
  return response;
}
// Обложка «Сегодня» живёт по часам: чтобы прогон не зависел от времени суток,
// страница видит один и тот же день — 13:00, фаза «день». Таймеры при этом
// идут как обычно.
const dayAt = (hour) => { const at = new Date(); at.setHours(hour, 0, 0, 0); return at; };
// Дело на другой день с «Сегодня» уходит: там только сегодняшнее, просроченное
// и то, что без срока. Оно лежит на доске и в /api/entries.
async function entryByRaw(page, raw) {
  const entries = await (await page.request.get("/api/entries")).json();
  return entries.entries.find((entry) => entry.raw.includes(raw));
}
// Дела и встречи на другой день живут в своём дне: стрелки по дням внутри
// ящика «День». Смещение считается от сегодняшнего дня.
async function showDay(page, offset) {
  const back = page.locator('#todo .daynav [data-view="0"]');
  if (await back.count()) await back.click();
  const step = page.locator(`#todo .daynav [data-step="${offset > 0 ? 1 : -1}"]`);
  for (let i = 0; i < Math.abs(offset); i += 1) await step.click();
}
// Запись без указания срока сервер кладёт на сегодня; дело «в запасе» — это дело,
// у которого срок сняли (как кнопкой «Снять срок»).
async function withoutDue(request, created) {
  const { entry } = await created.json();
  const response = await request.post(`/api/captures/${entry.id}/corrections`, {
    data: { at: Date.now(), patch: { schedule: { date: null, time: null } } },
  });
  expect(response.ok()).toBe(true);
  return { entry };
}
// Ящик открывается вкладкой; уже открытый вторым щелчком не закрывается.
async function openTab(page, name) {
  const tab = page.getByRole("tab", { name });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}
test.beforeEach(async ({ page, request }) => {
  await request.post("/api/reset", {
    data: { confirmation: "СБРОСИТЬ КИЗУНА" },
  });
  await page.clock.install({ time: dayAt(13) });
});
test("async capture shows a short success notification and adds the entry to the overview", async ({
  page,
}) => {
  await page.goto("/");
  // В шапке пять разделов и шестерёнка: «Сделано» стоит первым, перед «Сегодня»; Календарь
  // вернулся между «Доской» и «Заметками», а Круги, «?» и меню модели ушли.
  await expect(page.locator("header nav a")).toHaveText(["Сделано", "Сегодня", "Доска", "Календарь", "Заметки"]);
  await expect(page.locator("header nav a.active")).toHaveText("Сегодня");
  await expect(page.locator(".settings-link")).toHaveAttribute("href", "#settings");
  await expect(page.locator(".ai-menu, .help-link")).toHaveCount(0);
  await capture(page, "Завтра в 11 созвон по Hub");
  await expect(page.locator("#capture-notifications")).toContainText("Готово");
  // Единственный ответ на запись: что легло и на какой день.
  await expect(page.locator("#toast")).toContainText(/Легло: «.*созвон по Hub.*» · завтра/i);
  // Дело на завтра с сегодняшнего списка ушло, но в журнале есть.
  await expect(page.locator("#todo")).not.toContainText(/созвон по Hub/i);
  expect(await entryByRaw(page, "созвон по Hub")).toBeTruthy();
  await page.screenshot({ path: "tmp/screenshots/async-capture-ready.png" });
});
test("medium-confidence Codex classification remains visible in Plan", async ({ page }) => {
  // Провайдера разбора выбирают в настройках, а не в шапке.
  await page.goto("/#settings");
  await page.getByLabel("Провайдер ИИ").selectOption("codex-cli");
  await page.goto("/#today");
  await capture(page, "Завтра в 11 созвон по Hub");
  // Заглушка Codex не разбирает срок: дело без даты лежит в сегодняшнем списке.
  await expect(page.locator("#todo")).toContainText("Созвон по Hub");
});
test("success notification disappears without shifting the drawers under the field", async ({
  page,
}) => {
  await page.goto("/");
  const drawersTop = await page.locator(".drawers").evaluate((element) => element.getBoundingClientRect().top);
  await capture(page, "Завтра в 12 встреча по Hub");
  expect(await page.locator(".drawers").evaluate((element) => element.getBoundingClientRect().top)).toBe(drawersTop);
  await expect(page.locator("#capture-notifications .capture-notification")).toHaveCount(0, {
    timeout: 5000,
  });
  // Под полем два ящика: «Сделано» и «День». Заметок и колонок больше нет.
  await expect(page.locator(".drawer-tab")).toHaveCount(2);
});
test("notification stack is pinned to the viewport right edge on desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await capture(page, "Завтра в 12 встреча для правого стека");
  const geometry = await page
    .locator("#capture-notifications .capture-notification")
    .first()
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { rightGap: window.innerWidth - bounds.right };
    });
  expect(geometry.rightGap).toBeLessThanOrEqual(24);
});
test("today separates reported work from the day's open todos", async ({
  page,
}) => {
  await page.goto("/");
  await capture(page, "доработал обновление контекста для Hub");
  // «Доработал X» — туду, закрытая сразу: она в «Сделано», не в «Дне».
  await expect(page.locator("#journal")).toContainText("доработал обновление контекста");
  await expect(page.locator("#todo")).not.toContainText("доработал обновление контекста");
  await capture(page, "Завтра в 11 созвон по Hub");
  // Завтрашнее дело живёт в завтрашнем дне, а не в сегодняшнем списке.
  await expect(page.locator("#todo")).not.toContainText("созвон по Hub");
  await showDay(page, 1);
  await expect(page.locator("#todo")).toContainText("созвон по Hub");
  await showDay(page, 0);
  await capture(page, "Сегодня посмотрел работу с голосовым ИИ");
  // Любая запись — туду: даже наблюдение ложится в «День», а не в заметки.
  const entries = await (await page.request.get("/api/entries")).json();
  expect(entries.entries.some((entry) => entry.raw.includes("голосовым ИИ"))).toBe(true);
  await expect(page.locator("#todo")).toContainText("голосовым ИИ");
  await expect(page.getByRole("tab", { name: /^Сделано/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /День/ })).toBeVisible();
  // Ящика «Заметки» нет: остались две вкладки.
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator("#today-notes, #tab-notes")).toHaveCount(0);
  expect(await page.locator("#attention").count()).toBe(0);
  await page.evaluate(() => { location.hash = "#memory"; });
  await expect(page.locator("#memory")).toBeVisible();
  await expect(page.locator("#today")).toBeHidden();
});
// Одна запись — два разных действия: отчёт о встрече несёт и результат, и
// намерения на будущее. Намерения уходят своими делами, исходная запись
// остаётся целой и помнит, что из неё вышло.
test("запись с намерениями дробится на дела, и это видно в уведомлении и в карточке", async ({ page }) => {
  const raw = [
    "Созвонились по ВойсОпс",
    "Что решили, 2 вектора",
    "1. Допинываем бот детектор",
    "2. Допинываем карусель с генератором фраз",
  ].join("\n");
  await page.goto("/");
  const posted = page.waitForResponse((response) => response.url().endsWith("/api/captures") && response.request().method() === "POST");
  await page.getByLabel("Новая запись").fill(raw);
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  expect((await posted).status()).toBe(202);

  // Уведомление говорит, что отделилось, и даёт это убрать.
  const notification = page.locator("#capture-notifications .capture-notification");
  await expect(notification).toContainText("Отделил 2 дела", { timeout: 20000 });
  await expect(notification).toContainText("«Допинываем бот детектор»");
  await expect(notification.getByRole("button", { name: "Убрать дела" })).toBeVisible();

  // Дела живут в «Дне» обычными делами, а не строчками внутри чужой заметки.
  await openTab(page, /^День/);
  await expect(page.locator("#todo")).toBeVisible();
  const deal = page.locator("#todo .entry").filter({ hasText: "Допинываем бот детектор" });
  await expect(deal).toBeVisible({ timeout: 20000 });

  // В карточке дела видно, из чего оно вышло.
  await deal.locator(".entry-title").click();
  const card = page.locator("#review-dialog");
  await expect(card).toBeVisible();
  await expect(card.locator(".card-origin")).toContainText("Отделено от записи");
  await page.keyboard.press("Escape");

  // Исходная запись цела и помнит оба дела.
  await openTab(page, /^Сделано/);
  const source = page.locator("#journal .entry").filter({ hasText: "Созвонились по ВойсОпс" });
  await expect(source).toBeVisible();
  await source.locator(".entry-title").click();
  // Отделённые дела — в разделе «Подзадачи» записи: два шага, оба открыты.
  await expect(card.locator("#card-subtasks .subtask-count")).toHaveText("0 / 2");
  await expect(card.locator("#card-subtasks .subtask-name").filter({ hasText: "Допинываем бот детектор" })).toHaveCount(1);
  await expect(card.locator("#card-subtasks .subtask-name").filter({ hasText: "Допинываем карусель" })).toHaveCount(1);
});
// Пустой журнал не объясняет себя сам: человек видит поле и не знает, что в
// него писать. Двое приглашённых так и ушли, не записав ничего.
test("пустой журнал предлагает первый шаг, и он исчезает после первой записи", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const start = page.locator("#todo .today-start");
  await expect(start).toBeVisible();
  const example = start.locator(".start-chip").first();
  const text = await example.textContent();
  await example.click();
  // Пример подставился в поле, но записан не сам: первая запись — руками.
  await expect(page.getByLabel("Новая запись")).toContainText(text);
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  await expect(page.locator("#capture-notifications")).toContainText(text);
  await expect(start).toBeHidden({ timeout: 20000 });
});
// Края карточки ввода тянутся, как у окна: нижний — высота, боковые — ширина.
// Карточка стоит по центру, поэтому правый край идёт за курсором, а ширина
// растёт на удвоенный сдвиг. Размер переживает перезагрузку, двойной клик по
// краю возвращает его.
test("карточка ввода тянется за края и помнит размер", async ({ page }) => {
  await page.goto("/");
  const form = page.locator("#capture-form");
  const field = page.getByLabel("Новая запись");
  const width = async () => (await form.boundingBox()).width;
  const height = async () => field.evaluate((element) => parseFloat(getComputedStyle(element).minHeight));
  const drag = async (dir, dx, dy) => {
    const box = await page.locator(`#capture-form .capture-resize[data-dir="${dir}"]`).boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2);
    await page.mouse.move(x + dx, y + dy);
    await page.mouse.up();
  };
  const startWidth = await width(), startHeight = await height();
  await drag("e", 60, 0);
  expect(Math.round(await width())).toBe(Math.round(startWidth + 120));
  await drag("s", 0, 60);
  expect(Math.round(await height())).toBe(Math.round(startHeight + 60));
  await page.reload();
  expect(Math.round(await width())).toBe(Math.round(startWidth + 120));
  expect(Math.round(await height())).toBe(Math.round(startHeight + 60));
  // Левый край уменьшает ширину, если тянуть внутрь.
  await drag("w", 30, 0);
  expect(Math.round(await width())).toBe(Math.round(startWidth + 60));
  await page.locator('#capture-form .capture-resize[data-dir="se"]').dblclick();
  expect(Math.round(await width())).toBe(Math.round(startWidth));
  expect(Math.round(await height())).toBe(Math.round(startHeight));
});

// Подсказка под полем и подпись кнопки называют клавишу платформы: ⌘ на Mac и iOS,
// Super на Linux (Android — не в счёт: ядро у него Linux, а рабочего стола нет),
// Ctrl везде ещё. Сама отправка принимает и metaKey, и ctrlKey.
test("подсказка под полем записи говорит, как отправить: «…+Enter — отправить»", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#capture-hint")).toContainText("+Enter — отправить");
  await expect(page.locator("#capture-hint")).toContainText("Enter — новая строка");
  await expect(page.locator("#capture-submit")).toHaveAttribute("title", /^Сохранить запись — .+\+Enter$/);
});
for (const [name, platform, agent, key] of [
  ["Mac", "MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", "⌘"],
  ["iPhone", "iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15", "⌘"],
  ["Linux", "Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0", "Super"],
  ["Android", "Linux armv8l", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile", "Ctrl"],
  ["Windows", "Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0", "Ctrl"],
]) {
  test(`подсказка под полем записи на ${name}: «${key}+Enter — отправить»`, async ({ page }) => {
    await page.addInitScript(([platformName, agentName]) => {
      Object.defineProperty(navigator, "platform", { get: () => platformName });
      Object.defineProperty(navigator, "userAgent", { get: () => agentName });
    }, [platform, agent]);
    await page.goto("/");
    await expect(page.locator("#capture-hint")).toHaveText(`${key}+Enter — отправить, Enter — новая строка`);
    await expect(page.locator("#capture-submit")).toHaveAttribute("title", `Сохранить запись — ${key}+Enter`);
  });
}

// Лист — увеличенное поле поверх затемнённой страницы. Esc его закрывает, и клик
// мимо листа тоже; клик внутри формы и в меню поля (оно лежит в <body>) — нет.
test("лист поля записи закрывается кликом в сторону, а внутри формы и в меню поля остаётся", async ({ page }) => {
  await page.goto("/");
  const form = page.locator("#capture-form");
  const field = page.getByLabel("Новая запись");
  await page.locator("#capture-expand").click();
  await expect(form).toHaveClass(/capture-large/);
  await expect(page.locator("body")).toHaveClass(/capture-large-open/);
  // Клик по самому листу — по полю и по подсказке под ним — лист не закрывает.
  await field.click();
  await expect(form).toHaveClass(/capture-large/);
  await page.locator("#capture-hint").click();
  await expect(form).toHaveClass(/capture-large/);
  // Подсказка страниц по «[[» лежит в <body>, а не в форме: нажатие в ней — не «мимо».
  await field.click();
  await page.keyboard.type("[[Тест");
  const links = page.locator(".link-menu:visible");
  await expect(links).toBeVisible();
  await links.dispatchEvent("pointerdown", { button: 0 });
  await expect(form).toHaveClass(/capture-large/);
  await field.fill("");
  await expect(links).toHaveCount(0);
  // Так же панель оформления над выделением.
  await page.keyboard.type("Черновик для листа");
  await page.keyboard.press("ControlOrMeta+a");
  const bar = page.locator(".fmt-bar");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Жирный · ⌘B" }).click();
  await expect(field).toHaveText("**Черновик для листа**");
  await expect(form).toHaveClass(/capture-large/);
  // Клик по затемнённому фону закрывает лист; набранное остаётся в поле.
  await page.mouse.click(10, 400);
  await expect(form).not.toHaveClass(/capture-large/);
  await expect(page.locator("body")).not.toHaveClass(/capture-large-open/);
  await expect(field).toHaveText("**Черновик для листа**");
  // Без листа клик мимо поля ничего не открывает и ничего не меняет.
  await page.mouse.click(10, 400);
  await expect(form).not.toHaveClass(/capture-large/);
});

// Обложка и список не говорят одно и то же: дата с брифом видны, только пока
// оба ящика закрыты — иначе «Вторник, 15 сентября» стоит на экране дважды,
// сверху и в полосе дней. Днём фаза открывает «День», поэтому страница
// встречает списком.
test("дата и бриф пропадают при раскрытом ящике и возвращаются, когда всё свёрнуто", async ({ page }) => {
  await page.goto("/");
  const brief = page.locator("#today-brief");
  const date = page.locator("#today-date");
  const dayNavDate = page.locator("#todo .daynav b");
  const dayTab = page.getByRole("tab", { name: /^День/ });
  const journalTab = page.getByRole("tab", { name: /^Сделано/ });
  await expect(dayTab).toHaveAttribute("aria-selected", "true");
  await expect(brief).toBeHidden();
  await expect(date).toBeHidden();
  // Дата на экране всё-таки есть — одна, в полосе дней раскрытого ящика.
  await expect(dayNavDate).toBeVisible();
  // Свернули — обложка вернулась на своё место, над полем ввода.
  await dayTab.click();
  await expect(date).toBeVisible();
  await expect(brief).toBeVisible();
  await expect(brief).not.toHaveText("");
  // Соседний ящик прячет их так же.
  await journalTab.click();
  await expect(date).toBeHidden();
  await expect(brief).toBeHidden();
  await journalTab.click();
  await expect(date).toBeVisible();
  await expect(brief).toBeVisible();
});
// Стрелки уводят ящик в другой день, но переключение ящика — всегда «сегодня»:
// закрыли, открыли соседний или вернулись — оба дня сегодняшние.
test("переключение ящика возвращает оба дня на сегодня", async ({ page }) => {
  await page.goto("/");
  const dayTab = page.getByRole("tab", { name: /^День/ });
  const journalTab = page.getByRole("tab", { name: /^Сделано/ });
  const dayLabel = page.locator("#tab-day .drawer-tab-label");
  const journalLabel = page.locator("#tab-journal .drawer-tab-label");
  const dayToday = page.locator("#todo .daynav .daynav-mark");
  const journalToday = page.locator("#journal .daynav .daynav-mark");

  // Ушли стрелкой в завтра: это видно и в ящике, и на самой вкладке.
  await showDay(page, 1);
  await expect(dayLabel).not.toHaveText("День");
  await expect(dayToday).toHaveCount(0);

  // Открыли соседний ящик — «День» уже вернулся на сегодня.
  await journalTab.click();
  await expect(journalToday).toBeVisible();
  await expect(journalLabel).toHaveText("Сделано");
  await expect(dayLabel).toHaveText("День");

  // Теперь в другой день ушёл «Сделано» — и вернулся, когда открыли «День».
  await page.locator('#journal .daynav [data-step="-1"]').click();
  await expect(journalLabel).not.toHaveText("Сделано");
  await dayTab.click();
  await expect(dayToday).toBeVisible();
  await expect(journalLabel).toHaveText("Сделано");

  // Закрыли ящик — открытый снова показывает сегодня, а не тот день.
  await page.locator('#todo .daynav [data-step="1"]').click();
  await expect(dayToday).toHaveCount(0);
  await dayTab.click();
  await expect(page.locator("#todo")).toBeHidden();
  await expect(dayLabel).toHaveText("День");
  await dayTab.click();
  await expect(dayToday).toBeVisible();
});
test("the day keeps every todo together; tomorrow's ones wait for their day", async ({
  page,
}) => {
  const task = "Нужно подготовить контекст для Hub";
  const meeting = "Завтра в 11 созвон по Hub";
  const note = "Посмотрел работу с голосовым ИИ";
  await page.goto("/");
  await capture(page, task);
  await capture(page, meeting);
  await capture(page, note);
  await expect(page.locator("#todo")).toContainText(task);
  // Наблюдение — тоже туду на сегодня, у него есть кружок; в другой ящик оно не уходит.
  await expect(page.locator("#todo")).toContainText("голосовым ИИ");
  await expect(page.locator("#todo .completion-button").first()).toBeVisible();
  await expect(page.locator("#todo")).not.toContainText("созвон по Hub");
  expect(await page.locator(".calendar-block").count()).toBe(0);
  await expect(page.locator("#tab-day")).toContainText("2 дела");
  await showDay(page, 1);
  await expect(page.locator("#todo")).toContainText(meeting);
  await expect(page.locator("#todo")).not.toContainText(task);
  await openTab(page, /^Сделано/);
  await expect(page.locator("#journal")).not.toContainText(note);
  await expect(page.locator("#todo")).toBeHidden();
});
test("TODO buffer keeps overdue incomplete items ahead of other open work", async ({
  page,
}) => {
  const overdue = "Нужно отправить просроченный отчёт";
  await page.goto("/");
  await capture(page, overdue);
  const entries = await (await page.request.get("/api/entries")).json();
  const entry = entries.entries.find((candidate) => candidate.raw === overdue);
  const yesterday = await page.evaluate(() => {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Samara",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return formatter.format(date);
  });
  await page.request.post(`/api/captures/${entry.id}/corrections`, {
    data: {
      patch: {
        schedule: { date: yesterday, time: "10:00" },
      },
    },
  });
  await capture(page, "Нужно проверить обычную открытую задачу");
  await page.reload();
  const firstTodo = page.locator("#todo .entry").first();
  await expect(firstTodo).toContainText(overdue);
  await expect(firstTodo).toHaveClass(/overdue/);
  // «Просрочено» говорит заголовок полосы; у самой строки — чип «со вчера».
  await expect(page.locator("#todo .day-late .entry").first()).toContainText(overdue);
  await expect(page.locator("#todo .day-group.late")).toContainText("просрочено");
  await expect(firstTodo.locator(".tag.due.late")).toHaveText("со вчера");
});
test("reported meeting stays in Done without becoming an active plan item", async ({
  page,
}) => {
  const raw = "Сегодня поговорили на дейли по Hub";
  await page.goto("/");
  await capture(page, raw);
  await expect(page.locator("#journal")).toContainText(raw);
  await expect(page.locator("#todo")).not.toContainText(raw);
});
test("completed reports, including ready wording, are Done while negated reports stay open todos", async ({
  page,
}) => {
  const completed = "Готово: обсудили план по Hub";
  const negated = "Ничего не сделал по Hub";
  await page.goto("/");
  await capture(page, completed);
  await expect(page.locator("#journal")).toContainText(completed);
  await expect(page.locator("#todo")).not.toContainText(completed);
  await capture(page, negated);
  // Отрицание — не сделанное: заметок нет, запись остаётся открытым туду на
  // сегодня и в «Сделано» не попадает.
  await expect(page.locator("#todo")).toContainText(negated);
  await expect(page.locator("#journal")).not.toContainText(negated);
});
test("async conflict keeps correction folded until the user asks to clarify", async ({
  page,
}) => {
  const raw = "Завтра и послезавтра созвон по Hub";
  await page.goto("/");
  await capture(page, raw);
  const card = page.locator("#todo .entry").filter({ hasText: raw }).first();
  await expect(
    card.locator(".entry-title"),
  ).toBeVisible();
  await expect(page.locator("#review")).toBeHidden();
  await card.locator(".entry-title").click();
  await expect(page.locator("#review")).toContainText(
    "Какое из указанных времени верно?",
  );
  await expect(page.locator(".review-confidence")).toBeHidden();
});
test("ambiguous async meeting has a compact clarification action", async ({
  page,
}) => {
  const raw = "Созвон завтра после обеда с BE";
  await page.goto("/");
  await capture(page, raw);
  // Встреча без ясного времени требует уточнения и потому лежит в сегодняшнем дне.
  const card = page.locator(".entry").filter({ hasText: raw }).first();
  await expect(
    card.locator(".entry-title"),
  ).toBeVisible();
  await expect(page.locator("#review")).toBeHidden();
  await card.locator(".entry-title").click();
  await expect(page.locator("#review")).toBeVisible();
  // Типа у записи нет: вместо выбора типа в карточке — день и колонка.
  await page.locator("#review-params-toggle").click();
  await expect(page.locator("#review-date")).toBeVisible();
  await expect(page.locator("#review-primary-type")).toHaveCount(0);
  await expect(page.locator(".review-confidence")).toBeHidden();
});
test("user completion survives reload, is single-flight, and undo returns a todo to work", async ({
  page,
}) => {
  const raw = "Сегодня в 11 созвон по Hub для completion";
  await page.goto("/");
  await capture(page, raw);
  await page.reload();
  const card = page
      .locator("#todo .entry")
      .filter({ hasText: raw })
      .first(),
    complete = card.getByRole("button", { name: "Готово" });
  await complete.evaluate((button) => {
    button.click();
    button.click();
  });
  // Закрытое дело уходит из «Дня» и встаёт в «Сделано» с временем закрытия.
  await expect(page.locator("#todo")).not.toContainText(raw);
  await openTab(page, /^Сделано/);
  const closed = page.locator("#journal .entry").filter({ hasText: raw });
  await expect(closed).toHaveCount(1);
  await expect(closed.locator(".tag.time")).toHaveText(/^\d{2}:\d{2}$/);
  await page.screenshot({
    path: "tmp/screenshots/completion-ledger-fixture.png",
  });
  // Закрытие записано в данных, а не в состоянии страницы: переживает перезагрузку.
  await page.reload();
  await openTab(page, /^Сделано/);
  await expect(page.locator("#journal .entry").filter({ hasText: raw })).toHaveCount(1);
  const entries = await (await page.request.get("/api/entries")).json(),
    entry = entries.entries.find((candidate) => candidate.raw === raw),
    projection = entry.projections.find(
      (candidate) => candidate.type === "task",
    );
  expect(projection.completion.completed).toBe(true);
  expect(projection.completion.completedAt).toBeTruthy();
  // Двойной щелчок по «Вернуть в работу» — один запрос: кнопка гаснет сразу.
  await page
    .locator("#journal .entry")
    .filter({ hasText: raw })
    .getByRole("button", { name: /Вернуть в работу/ })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(page.locator("#journal")).not.toContainText(raw);
  await openTab(page, /^День/);
  await expect(
    page
      .locator("#todo .entry")
      .filter({ hasText: raw })
      .getByRole("button", { name: "Готово" }),
  ).toBeVisible();
  await page.reload();
  await openTab(page, /^День/);
  await expect(
    page
      .locator("#todo .entry")
      .filter({ hasText: raw })
      .getByRole("button", { name: "Готово" }),
  ).toBeVisible();
  expect(await page.locator(".completion-candidate").count()).toBe(0);
});
test("provider selection persists and explicit fallback never says not configured", async ({
  page,
}) => {
  await page.goto("/");
  await capture(page, "Завтра в 11 созвон по Hub");
  await expect(page.locator("#capture-notifications")).not.toContainText(
    "не настроен",
  );
  await page.reload();
  await expect(page.getByLabel("Провайдер ИИ")).toHaveValue("openrouter");
});
test("an unavailable requested provider is labelled unavailable", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("pagent.ai-provider", "openai"),
  );
  await page.goto("/#settings");
  await expect(page.locator("#ai-status")).toContainText("OpenAI — недоступен");
});
test("reload resumes one pending poller without a second capture POST", async ({
  page,
}) => {
  let capturePosts = 0,
    statusReads = 0;
  await page.route("**/api/captures", async (route) => {
    capturePosts += 1;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        captureId: "capture-pending",
        jobId: "job-pending",
        statusUrl: "/api/jobs/job-pending",
      }),
    });
  });
  await page.route("**/api/jobs/job-pending", async (route) => {
    statusReads += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-pending",
        captureId: "capture-pending",
        state: statusReads < 3 ? "running" : "succeeded",
        stage: statusReads < 3 ? "classifying" : "complete",
        retryable: false,
        usedProvider: "fallback",
      }),
    });
  });
  await page.goto("/");
  await page.getByLabel("Новая запись").fill("Не дублировать при перезагрузке");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  await expect(page.locator("#capture-notifications")).toContainText(
    "ИИ разбирает запись",
  );
  await page.reload();
  await expect(page.locator("#capture-notifications .capture-notification")).toHaveCount(0, {
    timeout: 7000,
  });
  expect(capturePosts).toBe(1);
});
test("parallel captures retain a vertical stack without overwriting each other", async ({
  page,
}) => {
  let capturePosts = 0,
    releaseOld;
  const oldStatusStarted = new Promise((resolve) => {
    releaseOld = resolve;
  });
  let resolveOld;
  const oldStatus = new Promise((resolve) => {
    resolveOld = resolve;
  });
  await page.route("**/api/captures", async (route) => {
    capturePosts += 1;
    const jobId = capturePosts === 1 ? "job-old" : "job-new";
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        captureId: `capture-${capturePosts}`,
        jobId,
        statusUrl: `/api/jobs/${jobId}`,
      }),
    });
  });
  await page.route("**/api/jobs/job-old", async (route) => {
    releaseOld();
    await oldStatus;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-old",
        captureId: "capture-1",
        state: "succeeded",
        stage: "complete",
        retryable: false,
        usedProvider: "fallback",
      }),
    });
  });
  await page.route("**/api/jobs/job-new", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-new",
        captureId: "capture-2",
        state: "running",
        stage: "classifying",
        retryable: false,
        usedProvider: null,
      }),
    }),
  );
  await page.goto("/");
  await page.getByLabel("Новая запись").fill("Старая запись");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  await oldStatusStarted;
  await page.getByLabel("Новая запись").fill("Новая запись");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  await expect(page.locator("#capture-notifications")).toContainText("Новая запись");
  resolveOld();
  await expect(page.locator("#capture-notifications")).toContainText("Новая запись");
  await expect(page.locator("#capture-notifications")).toContainText(
    "ИИ разбирает запись",
  );
  expect(capturePosts).toBe(2);
});
test("capture rejects legacy 201 and malformed 202 without starting a poller", async ({
  page,
}) => {
  let call = 0;
  await page.route("**/api/captures", (route) => {
    call += 1;
    return route.fulfill({
      status: call === 1 ? 201 : 202,
      contentType: "application/json",
      body: JSON.stringify(
        call === 1 ? { entry: {} } : { captureId: "capture-only" },
      ),
    });
  });
  await page.goto("/");
  for (const raw of ["Не принимать 201", "Не принимать неполный 202"]) {
    await page.getByLabel("Новая запись").fill(raw);
    await page.getByRole("button", { name: "Сохранить запись" }).click();
    await expect(page.locator("#toast")).toContainText(
      "не подтвердил асинхронное сохранение",
    );
    // Поле записи — не textarea, а редактируемая область с живой разметкой:
    // текст читается как содержимое, а не как value.
    await expect(page.getByLabel("Новая запись")).toHaveText(raw);
    expect(await page.locator("#capture-notifications .capture-notification").count()).toBe(0);
    expect(
      await page.evaluate(() => localStorage.getItem("pagent.active-captures")),
    ).toBeNull();
  }
  expect(call).toBe(2);
});
test("online bootstrap retries initial failures and resumes one stored job", async ({
  page,
}) => {
  let offline = true,
    jobReads = 0;
  await page.addInitScript(() =>
    localStorage.setItem(
      "pagent.active-captures",
      JSON.stringify([{
        captureId: "capture-reconnect",
        jobId: "job-reconnect",
        statusUrl: "/api/jobs/job-reconnect",
        raw: "Вернуться после сети",
        provider: "fallback",
      }]),
    ),
  );
  await page.route("**/api/status**", (route) =>
    offline ? route.abort() : route.continue(),
  );
  await page.route("**/api/day**", (route) =>
    offline ? route.abort() : route.continue(),
  );
  await page.route("**/api/jobs/job-reconnect", (route) => {
    jobReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-reconnect",
        captureId: "capture-reconnect",
        state: "running",
        stage: "classifying",
        retryable: false,
        usedProvider: null,
      }),
    });
  });
  await page.goto("/");
  await expect(page.locator("#toast")).toContainText(
    "Не удалось загрузить данные",
  );
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#capture-notifications")).toContainText(
    "Вернуться после сети",
  );
  await expect(page.locator("#capture-notifications")).toContainText(
    "ИИ разбирает запись",
  );
  expect(jobReads).toBe(1);
});
test("online during an active bootstrap schedules one follow-up load", async ({
  page,
}) => {
  let statusReads = 0;
  let releaseFirstStatus;
  const firstStatus = new Promise((resolve) => {
    releaseFirstStatus = resolve;
  });
  await page.route("**/api/status**", async (route) => {
    statusReads += 1;
    if (statusReads === 1) await firstStatus;
    await route.continue();
  });
  await page.goto("/");
  await expect.poll(() => statusReads).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  releaseFirstStatus();
  await expect.poll(() => statusReads, { timeout: 5000 }).toBe(2);
});
test("failed cancellation resumes one poller for the same active job", async ({
  page,
}) => {
  let jobReads = 0;
  await page.route("**/api/captures", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        captureId: "capture-cancel-retry",
        jobId: "job-cancel-retry",
        statusUrl: "/api/jobs/job-cancel-retry",
      }),
    }),
  );
  await page.route("**/api/jobs/job-cancel-retry", (route) => {
    jobReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-cancel-retry",
        captureId: "capture-cancel-retry",
        state: jobReads === 1 ? "running" : "succeeded",
        stage: jobReads === 1 ? "classifying" : "complete",
        retryable: false,
        usedProvider: "fallback",
      }),
    });
  });
  await page.route("**/api/jobs/job-cancel-retry/cancel", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { message: "Отмена временно недоступна." },
      }),
    }),
  );
  await page.goto("/");
  await page
    .getByLabel("Новая запись")
    .fill("Дождаться статуса после ошибки отмены");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  await expect(
    page.getByRole("button", { name: "Отменить классификацию" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Отменить классификацию" }).click();
  await expect(
    page.getByRole("button", { name: "Отменить классификацию" }),
  ).toBeEnabled();
  await expect.poll(() => jobReads, { timeout: 2500 }).toBe(2);
  await expect(page.locator("#capture-notifications")).toContainText("Готово");
  await page.waitForTimeout(1300);
  expect(jobReads).toBe(2);
});
test("provider selection has one stable listener after failed and repeated online bootstraps", async ({
  page,
}) => {
  let online = false,
    statusReads = 0;
  await page.route("**/api/status**", (route) => {
    statusReads += 1;
    return online ? route.continue() : route.abort();
  });
  await page.goto("/");
  await expect(page.locator("#toast")).toContainText(
    "Не удалось загрузить данные",
  );
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => statusReads).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => statusReads).toBe(3);
  await page.evaluate(() => { location.hash = "#settings"; });
  await page.getByLabel("Провайдер ИИ").selectOption("fallback");
  await expect.poll(() => statusReads).toBe(4);
  expect(
    await page.evaluate(() => localStorage.getItem("pagent.ai-provider")),
  ).toBe("fallback");
});
test("cancelled and failed jobs keep raw text visible and expose explicit next action", async ({
  page,
}) => {
  await page.route("**/api/captures", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        captureId: "capture-cancel",
        jobId: "job-cancel",
        statusUrl: "/api/jobs/job-cancel",
      }),
    }),
  );
  await page.route("**/api/jobs/job-cancel", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-cancel",
        captureId: "capture-cancel",
        state: "running",
        stage: "classifying",
        retryable: false,
        usedProvider: null,
      }),
    }),
  );
  await page.route("**/api/jobs/job-cancel/cancel", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-cancel",
        captureId: "capture-cancel",
        state: "cancelled",
        stage: "cancelled",
        retryable: true,
        usedProvider: null,
      }),
    }),
  );
  await page.goto("/");
  await page.getByLabel("Новая запись").fill("Сохранить при отмене");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  await expect(
    page.getByRole("button", { name: "Отменить классификацию" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Отменить классификацию" }).click();
  await expect(page.locator("#capture-notifications")).toContainText("Отменено");
  await expect(page.locator("#capture-notifications")).toContainText(
    "Сохранить при отмене",
  );
  await expect(
    page.getByRole("button", { name: /Повторить/ }),
  ).toBeVisible();
});
test("a failed job keeps the raw capture and offers an explicit retry", async ({
  page,
}) => {
  await page.route("**/api/captures", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        captureId: "capture-failed",
        jobId: "job-failed",
        statusUrl: "/api/jobs/job-failed",
      }),
    }),
  );
  await page.route("**/api/jobs/job-failed", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "job-failed",
        captureId: "capture-failed",
        state: "failed",
        stage: "failed",
        retryable: true,
        usedProvider: null,
        error: "unavailable",
      }),
    }),
  );
  await page.goto("/");
  await page.getByLabel("Новая запись").fill("Сохранить при ошибке");
  await page.getByRole("button", { name: "Сохранить запись" }).click();
  await expect(page.locator("#capture-notifications")).toContainText(
    "Не удалось разобрать",
  );
  await expect(page.locator("#capture-notifications")).toContainText(
    "Сохранить при ошибке",
  );
  await expect(
    page.getByRole("button", { name: /Повторить/ }),
  ).toBeVisible();
});
test("correction from a today card after reload is single-flight", async ({
  page,
}) => {
  const raw = "Сегодня в 11 созвон по Hub";
  await page.goto("/");
  await capture(page, raw);
  await page.reload();
  await expect(page.locator("#todo")).toContainText("созвон по Hub");
  let corrections = 0;
  page.on("request", (request) => {
    if (request.url().includes("/corrections") && request.method() === "POST")
      corrections += 1;
  });
  const card = page
    .locator("#todo .entry")
    .filter({ hasText: raw })
    .first();
  await card.locator(".entry-title").click();
  await page.locator("#review-params-toggle").click();
  await page.locator("#review-people").fill("Свой человек");
  // Кнопки «сохранить» нет: свойства уходят при закрытии карточки. Второй
  // клик по крестику попадает в уже закрывающуюся карточку — уточнение одно.
  await page.locator("#review-close").evaluate((button) => {
    button.click();
    button.click();
  });
  await expect.poll(async () => (await entryByRaw(page, raw)).interpretation.classification.entities.people).toContain("Свой человек");
  expect(corrections).toBe(1);
});
test("correction from a plan card after reload is single-flight and creates one version", async ({
  page,
}) => {
  const raw = "Нужно проверить Hub для attention";
  await page.goto("/");
  await capture(page, raw);
  await page.reload();
  await expect(page.locator("#todo")).toContainText(raw);
  let corrections = 0;
  page.on("request", (request) => {
    if (request.url().includes("/corrections") && request.method() === "POST")
      corrections += 1;
  });
  const card = page
    .locator("#todo .entry")
    .filter({ hasText: raw })
    .first();
  await card.locator(".entry-title").click();
  await page.locator("#review-params-toggle").click();
  await page.locator("#review-people").fill("Attention человек");
  await page.locator("#review-close").evaluate((button) => {
    button.click();
    button.click();
  });
  await expect.poll(async () => (await entryByRaw(page, raw)).interpretation.version).toBe(2);
  const entry = await entryByRaw(page, raw);
  expect(entry.interpretation.classification.entities.people).toContain("Attention человек");
  expect(corrections).toBe(1);
});
test("memory disables controls while pending and restores them after the response", async ({
  page,
}) => {
  let release;
  const answer = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/memory/answer", async (route) => {
    await answer;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        answer: "Контекст найден.",
        citationIds: [],
        sources: [],
        provenance: {
          requestedProvider: "fallback",
          usedProvider: "fallback",
          provider: "fallback",
          fallbackReason: "not_configured",
        },
      }),
    });
  });
  await page.goto("/");
  await page.evaluate(() => { location.hash = "#memory"; });
  await page.getByLabel("Вопрос к памяти").fill("Что было по Hub?");
  await page.getByRole("button", { name: "Спросить" }).click();
  await expect(page.getByLabel("Вопрос к памяти")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Спросить" })).toBeDisabled();
  await expect(page.locator("#memory-result")).toContainText("Ищем в памяти");
  release();
  await expect(page.getByLabel("Вопрос к памяти")).toBeEnabled();
  await expect(page.locator("#memory-result")).toContainText(
    "Контекст найден.",
  );
});
test("mobile critical path has no horizontal overflow and keeps capture and corrections reachable", async ({
  page,
}) => {
  const raw = "Сегодня в 11 созвон с Илья по Hub";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await capture(page, raw);
  await expect(page.locator("#capture-notifications")).toContainText(raw);
  await expect(
    page
      .locator("#todo .entry")
      .filter({ hasText: raw })
      .locator(".entry-title"),
  ).toBeVisible();
  await page.screenshot({
    path: "tmp/screenshots/mobile-390-async-capture.png",
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
test("initial root load and legacy deck produce no console, page or resource errors", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto("/");
  await expect(page.getByLabel("Новая запись")).toBeVisible();
  // Кнопка отправки на месте всегда; кнопки разговора больше нет.
  await expect(page.getByRole("button", { name: "Сохранить запись" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Поговорить с журналом" })).toHaveCount(0);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    /^data:image\/svg\+xml/,
  );
  expect(errors).toEqual([]);
});
test("morning brief loads, refreshes and opens a safe source record", async ({
  page,
}) => {
  const raw = "Сегодня в 10 созвон по Hub для утренней сводки";
  await page.goto("/");
  await capture(page, raw);
  await page.evaluate(() => { location.hash = "#brief"; });
  await expect(page.locator("#daily-brief")).toContainText(
    /Ежедневный отчёт|Готовим отчёт/,
  );
  await page.getByRole("button", { name: "Обновить" }).click();
  await expect(page.locator("#daily-brief")).toContainText("Сегодня");
  const source = page
    .locator("#daily-brief")
    .getByRole("button", { name: "Открыть источник" })
    .first();
  await expect(source).toBeVisible();
  await source.click();
  await expect(page.locator("#daily-brief-source-dialog")).toContainText(raw);
  await page.getByRole("button", { name: "Открыть карточку" }).click();
  await expect(page.locator("#today")).toBeVisible();
  await expect(page.locator(`#todo [data-capture-id]`)).toBeFocused();
  await expect(page.locator("#review")).toBeHidden();
  await page.screenshot({ path: "tmp/screenshots/daily-brief.png" });
});
test("morning brief safely opens an exact source after the bounded entry cache misses it", async ({
  page,
}) => {
  const captureId = "11111111-1111-4111-8111-111111111111",
    sourceId = "22222222-2222-4222-8222-222222222222",
    raw = "Старый точный источник";
  await page.route("**/api/daily-brief", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        date: "2026-08-21",
        timeZone: "Europe/Samara",
        revision: 1,
        generatedAt: "2026-08-20T00:00:00.000Z",
        content: {
          sections: [
            {
              key: "today",
              label: "Сегодня",
              empty: "",
              items: [{ key: "today-one", text: "Встреча" }],
            },
          ],
        },
        sources: [
          {
            sectionKey: "today",
            itemKey: "today-one",
            sourceType: "capture",
            sourceId,
            action: { kind: "capture", captureId },
          },
        ],
      }),
    }),
  );
  await page.route("**/api/entries?limit=100", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ entries: [] }),
    }),
  );
  await page.route(
    `**/api/daily-brief/2026-08-21/revisions/1/sources/${sourceId}`,
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          captureId,
          raw,
          occurredAt: "2026-08-20T00:00:00.000Z",
          createdAt: "2026-08-20T00:00:00.000Z",
        }),
      }),
  );
  await page.goto("/");
  await page.evaluate(() => { location.hash = "#brief"; });
  await page
    .locator("#daily-brief")
    .getByRole("button", { name: "Открыть источник" })
    .click();
  await expect(page.locator("#daily-brief-source-dialog")).toContainText(raw);
  await expect(
    page.getByRole("button", { name: "Открыть карточку" }),
  ).toHaveCount(0);
});

// Внутренняя ссылка Obsidian ведёт в память с запросом. Раньше роутер искал
// страницу с идентификатором «memory?query=Hub», не находил её и выбрасывал
// человека на «Сегодня» — щелчок по [[ссылке]] не делал ничего.
test("an obsidian wikilink opens memory with its query already searched", async ({
  page,
}) => {
  await page.goto("/");
  await capture(page, "Завтра в 11 созвон по Hub");
  await page.goto("/#memory?query=Hub");
  await expect(page.locator("#memory")).toBeVisible();
  await expect(page.locator("#today")).toBeHidden();
  await expect(page.locator("#memory-input")).toHaveValue("Hub");
  await expect(page.locator("#memory-result")).toContainText("Hub", {
    timeout: 7000,
  });
  expect(page.url()).toContain("#memory?query=Hub");

  // Несуществующая страница по-прежнему возвращает на «Сегодня».
  await page.goto("/#nope");
  await expect(page.locator("#today")).toBeVisible();
  expect(page.url()).toContain("#today");
});

// Карточки обновляются сами: журнал меняет не только эта вкладка — запись может
// прийти голосом, разбор закончиться в фоне, правка прилететь из другого окна.
test("карточки обновляются в реальном времени, без перезагрузки страницы", async ({
  page,
  request,
}) => {
  await page.goto("/");
  // Журнал пуст — в «Дне» стоит первый шаг, а не список.
  await expect(page.locator("#todo .today-start")).toBeVisible();

  // Запись создаётся мимо этой вкладки — как это делает голос или другое окно.
  const created = await request.post("/api/captures", {
    data: { raw: "дело про поток обновлений", primaryType: "todo" },
  });
  expect(created.status()).toBe(201);

  // Ничего не перезагружаем: карточка должна появиться сама.
  await expect(page.locator("#todo .entry").first()).toContainText("поток обновлений", {
    timeout: 15000,
  });

  // Удаление тоже видно сразу.
  const entry = (await created.json()).entry;
  await request.delete(`/api/captures/${entry.id}`);
  await expect(page.locator("#todo .entry")).toHaveCount(0, { timeout: 15000 });
});

test("в «Дне» дело — плотная строка без времени записи, в «Сделано» — со временем закрытия", async ({ page, request }) => {
  await page.goto("/");
  const created = await request.post("/api/captures", {
    data: {
      raw: "созвон по Hub",
      due: { date: "2026-08-27", time: "11:00" },
    },
  });
  expect(created.status()).toBe(201);
  const entry = page.locator("#todo .entry").filter({ hasText: "созвон по Hub" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });

  // Срок в прошлом: строка красная, с чипом «с 27 авг». Ни типа, ни проекта,
  // ни тегов, ни времени записи в ней нет.
  await expect(entry).toHaveClass(/dense/);
  await expect(entry).toHaveClass(/overdue/);
  await expect(entry.locator(".entry-meta .tag.due")).toHaveText("с 27 авг");
  await expect(entry.locator(".entry-meta .tag.project, .entry-meta .tag.task")).toHaveCount(0);
  await expect(entry.locator(".entry-meta")).not.toContainText("срок:");
  await expect(entry.locator(".entry-meta")).not.toContainText(/сегодня, \d{2}:\d{2}/);

  // «Сделали X» — туду, закрытая при записи: в «Сделано» она строкой с
  // временем закрытия, а не временем записи с днём.
  const done = await request.post("/api/captures", { data: { raw: "Сделали разбор по Hub" } });
  await page.reload();
  await openTab(page, /^Сделано/);
  const card = page.locator("#journal .entry").filter({ hasText: "Сделали разбор по Hub" }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toHaveClass(/dense/);
  await expect(card).toHaveClass(/completed/);
  await expect(card.locator(".entry-meta .tag.time")).toHaveText(/^\d{2}:\d{2}$/);
  await expect(card.locator(".entry-meta")).not.toContainText(/сегодня, /);

  await request.delete(`/api/captures/${(await created.json()).entry.id}`);
  await request.delete(`/api/captures/${(await done.json()).entry.id}`);
});

test("«Сегодня» говорит, просрочено дело или нет: чип «с 27 сен» и красная строка", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");

  // Сроки берём рядом с сегодняшним днём: далёкие даты приложение не принимает.
  // Дни считаются в часовом поясе приложения, а не в UTC.
  const day = (shift) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() + shift * 86400000));
  const late = await request.post("/api/captures", {
    data: { raw: "сдать отчёт", due: { date: day(-3) } },
  });
  const yesterday = await request.post("/api/captures", {
    data: { raw: "позвонить банку", due: { date: day(-1) } },
  });
  const soon = await request.post("/api/captures", {
    data: { raw: "созвон по релизу", due: { date: day(3) } },
  });
  const undated = await request.post("/api/captures", {
    data: { raw: "купить кофе" },
  });

  const card = (text) => page.locator("#todo .entry").filter({ hasText: text }).first();
  await expect(card("сдать отчёт")).toBeVisible({ timeout: 15000 });
  await expect(card("сдать отчёт")).toHaveClass(/overdue/);
  // Просроченное — обычная строка списка с чипом: «со вчера» или «с 27 сен».
  await expect(card("позвонить банку").locator(".tag.due.late")).toHaveText("со вчера");
  await expect(card("сдать отчёт").locator(".tag.due.late")).toHaveText(/^с \d{1,2} [а-я]+$/);
  await expect(card("сдать отчёт").locator(".tag.late:not(.due)")).toHaveCount(0);

  // Дело без срока сервер кладёт на сегодня: метки срока у него нет вовсе.
  await expect(card("купить кофе").locator(".tag.due")).toHaveCount(0);
  await expect(card("купить кофе")).toHaveClass(/dense/);
  await expect(card("купить кофе")).not.toHaveClass(/overdue/);

  // Дело со сроком через три дня в сегодняшнем списке не стоит.
  await expect(page.locator("#todo")).not.toContainText("созвон по релизу");

  // В самой карточке видно, когда запись сделана.
  await card("купить кофе").locator(".entry-title").click();
  await page.locator("#review-dialog .card-source summary").click();
  await expect(page.locator("#review-dialog .card-source-body")).toContainText("Поле записи");
  // И ни одной подчёркнутой кнопки: подчёркивание читалось как ссылка.
  const underlined = await page.evaluate(() =>
    [...document.querySelectorAll("#review-dialog button, #review-dialog a")].filter((node) =>
      getComputedStyle(node).textDecorationLine.includes("underline"),
    ).length,
  );
  expect(underlined).toBe(0);
  await page.locator("#review-close").click();

  for (const response of [late, yesterday, soon, undated])
    await request.delete(`/api/captures/${(await response.json()).entry.id}`);
});

// «День» начинается со встреч: пока они лежали под делами, до «что у меня в
// 12:30» человек добирался через двенадцать строк. Просрочка под встречами не
// тонет — она идёт своей полосой, а остальные дела лежат плотными строками.
test("«День» показывает сначала встречи, потом просрочку, потом дела", async ({
  page,
  request,
}) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  const day = (shift) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() + shift * 86400000));
  const created = [];
  for (const data of [
    { raw: "сдать отчёт", due: { date: day(-3) } },
    { raw: "созвон с командой", due: { date: day(0), time: "16:30" } },
    { raw: "прибраться в заметках" },
  ])
    created.push(await request.post("/api/captures", { data }));
  await withoutDue(request, created[2]);

  const todo = page.locator("#todo");
  await expect(todo.locator(".entry")).toHaveCount(3, { timeout: 15000 });
  // Порядок разделов — это и есть ответ на «что я вижу первым».
  await expect(todo.locator(".day-group")).toHaveText(["по часам", "просрочено · 1", "на сегодня", "без срока · 1"]);
  // Сегодняшнее без часа — пусто: полка говорит, что дело можно взять из запаса.
  await expect(todo.locator(".day-shelf-empty")).toContainText("из запаса");
  await expect(todo.locator(".entry").first()).toContainText("созвон с командой");
  await expect(todo.locator(".now-mark")).toHaveCount(1);

  // Просрочка — в своей полосе, а не строкой общего списка. Слово «просрочено»
  // при ней больше не повторяется: его говорит заголовок полосы.
  const late = todo.locator(".day-late .entry");
  await expect(late).toHaveCount(1);
  await expect(late).toContainText("сдать отчёт");
  await expect(late).not.toContainText("просрочено");

  // Плотная строка: ни «задача», ни «без срока», ни времени записи.
  const row = todo.locator(".day-rows .entry").first();
  await expect(row).toHaveClass(/dense/);
  await expect(row).toContainText("прибраться в заметках");
  await expect(row).not.toContainText("без срока");
  await expect(row).not.toContainText("задача");

  // У встречи в её же часе срок не повторяется — время слева уже сказано.
  await expect(todo.locator(".day-row .entry")).not.toContainText("срок");

  for (const response of created)
    await request.delete(`/api/captures/${(await response.json()).entry.id}`);
});

// «День» — простой список: дела без срока показываются все, и своей полосы
// прокрутки у ящика нет. Обрезка выглядела как потерянные дела — три
// «Допинываем…» из двенадцати, и человек шёл искать остальные на доску; ящик с
// собственной прокруткой оказался не лучше — окошко в три строки, за нижним
// краем которого пряталось «по часам». Длинный день прокручивается страницей.
test("дела без срока показываются все, а ящик не заводит свою прокрутку", async ({
  page,
  request,
}) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");

  const created = [];
  for (let number = 1; number <= 12; number += 1)
    created.push(
      await request.post("/api/captures", { data: { raw: `дело номер ${number}`, primaryType: "todo" } }),
    );

  const todo = page.locator("#todo");
  await expect(todo.locator(".entry:visible")).toHaveCount(12, { timeout: 15000 });
  // Ничего не спрятано, поэтому и хвоста «Ещё N» нет: он остался только для
  // дел, назначенных на другие дни.
  await expect(todo.locator(".preview-more")).toHaveCount(0);
  // Ящик показан целиком: своей полосы прокрутки у него нет.
  const room = await todo.evaluate((box) => ({ visible: box.clientHeight, all: box.scrollHeight }));
  expect(room.all).toBeLessThanOrEqual(room.visible + 1);
  // Что не влезло на экран, достаётся прокруткой страницы, а не окошком внутри
  // ящика: последняя карточка доезжает до глаз обычной прокруткой.
  const last = todo.locator(".entry").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();

  for (const response of created)
    await request.delete(`/api/captures/${(await response.json()).entry.id}`);
});

// Дела на другие дни живут в своих днях: в сегодняшнем списке их нет, но хвост
// «Ещё N» их считает, а «Сделано» показывает всё закрытое за день.
test("future-dated todos stay in their days while the tail counts them", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  for (const name of ["первое дело", "второе дело", "третье дело"])
    await request.post("/api/captures", {
      data: { raw: name, due: { date: "2026-12-31" }, priority: "high", tags: ["первый", "второй", "третий"] },
    });
  for (const name of ["раз", "два", "три", "четыре", "пять", "шесть", "семь"])
    await request.post("/api/captures", { data: { raw: `Обсудили ${name}` } });
  const tail = page.locator("#todo .preview-more");
  await expect(tail).toHaveText("Ещё 3 — весь список →", { timeout: 15000 });
  await expect(tail).toHaveAttribute("href", "#board");
  expect(await page.locator("#todo .entry").count()).toBe(0);
  // Полный список — доска, открывается этой же ссылкой. В первый заход доска фильтрует по
  // «сегодня» и этих дел не показала бы, поэтому ссылка «весь список» снимает фильтр.
  await page.evaluate(() => localStorage.removeItem("kizuna-board-filter"));
  await tail.click();
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator("#board-columns .board-card").filter({ hasText: /первое|второе|третье/ })).toHaveCount(3);
  await expect(page.locator("#board-filter-toggle")).toHaveText("Фильтр");
  expect(await page.evaluate(() => localStorage.getItem("kizuna-board-filter"))).toBe("[]");
  await page.locator('nav a[href="#today"]').click();
  await openTab(page, /^Сделано/);
  // Семь «Обсудили …» — закрытые сразу туду: «Сделано» показывает все.
  await expect(page.locator("#journal .entry:visible")).toHaveCount(7, { timeout: 15000 });
  await expect(page.locator("#tab-journal b")).toHaveText("7");
  await expect(page.locator("#todo")).toBeHidden();
});

// Настройки в приложении: раньше это правилось только в .env с перезапуском.
test("настройки меняются в приложении и применяются сразу", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/#settings");
  await expect(page.locator("#settings")).toBeVisible();

  // Ключ показывается признаком, а не значением.
  await expect(page.locator("#setting-openaiKey")).toHaveValue("");
  await expect(page.locator("#state-openaiKey")).toHaveText(/не настроен|••••/);

  // Меняем напоминания и предел ответа модели.
  await page.locator("#setting-remindHour").selectOption("08:00");
  await page.locator("#setting-modelMaxTokens").fill("2048");
  await page.locator("#setting-modelMaxTokens").blur();
  await expect(page.locator("#settings-status")).toHaveText("Сохранено");

  // Сохранилось на сервере само, без кнопки, — и не только на экране.
  await expect
    .poll(async () => {
      const saved = (await (await request.get("/api/settings")).json()).settings;
      return [saved.remindHour, saved.modelMaxTokens].join("|");
    })
    .toBe("08:00|2048");

  // Шесть дел — шесть строк в ящике: ничего не обрезается и не прячется.
  const created = [];
  for (const name of ["дело 1", "дело 2", "дело 3", "дело 4", "дело 5", "дело 6"])
    created.push(await request.post("/api/captures", { data: { raw: name } }));
  await page.locator('nav a[href="#today"]').click();
  await expect(page.locator("#todo .entry:visible")).toHaveCount(6, { timeout: 15000 });

  // Возвращаем как было и убираем записи.
  await request.put("/api/settings", {
    data: { remindHour: "", modelMaxTokens: "" },
  });
  for (const response of created)
    await request.delete(`/api/captures/${(await response.json()).entry.id}`);
});


test("некорректная настройка не сохраняется и объясняет причину", async ({ page, request }) => {
  await page.goto("/#settings");
  await page.locator("#setting-timeZone").fill("Не/Зона");
  await page.locator("#setting-timeZone").blur();
  await expect(page.locator("#toast")).toContainText("Некорректное значение");
  const saved = await (await request.get("/api/settings")).json();
  expect(saved.settings.timeZone).not.toBe("Не/Зона");
});


// Расходы должны быть видны, а не выясняться в личном кабинете провайдера.
test("расходы видно в настройках", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/#settings");
  const table = page.locator("#usage-table");
  await expect(table).toContainText("За сутки");
  await expect(table).toContainText("За неделю");
  await expect(table).toContainText("Всего");
  // Пока ничего не потрачено — так и сказано.
  await expect(table).toContainText("Пока ничего не потрачено");

  // После разбора записи расход появляется сам, без перезагрузки настроек.
  await page.goto("/");
  await capture(page, "Завтра в 11 созвон по Hub");
  // Сначала убеждаемся, что расход вообще записан: иначе непонятно, врёт
  // страница или его правда нет.
  await expect
    .poll(async () => (await (await request.get("/api/usage")).json()).total.calls, { timeout: 15000 })
    .toBeGreaterThan(0);
  await page.goto("/#settings");
  await expect(page.locator("#usage-table")).not.toContainText("Пока ничего не потрачено");
  await expect(page.locator("#usage-table .usage-detail")).toContainText("fake/fast");
});




test("«День» делит сегодняшнее и запас, берёт дело на сегодня и закрывается с клавиатуры", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const today = (await (await request.get("/api/day")).json()).date;
  const created = [];
  for (const data of [
    { raw: "проработать тему путешествий", due: { date: today } },
    { raw: "потыкать новые AI-инструменты" },
    { raw: "собрать дни рождения команды" },
  ])
    created.push(await (await request.post("/api/captures", { data })).json());
  for (const { entry } of created.slice(1))
    await request.post(`/api/captures/${entry.id}/corrections`, { data: { at: Date.now(), patch: { schedule: { date: null, time: null } } } });
  await page.goto("/");
  const todo = page.locator("#todo");
  await expect(todo.locator(".entry")).toHaveCount(3, { timeout: 15000 });
  await expect(todo.locator(".day-group")).toHaveText(["на сегодня · 1", "без срока · 2"]);
  await expect(page.locator("#tab-day .drawer-count")).toContainText("1 дело");

  // «на сегодня» по наведению переносит дело из запаса на сегодняшнюю полку.
  const stock = todo.locator(".day-rows.stock .entry").filter({ hasText: "дни рождения" });
  await stock.hover();
  await stock.getByRole("button", { name: "на сегодня" }).click();
  await expect(todo.locator(".day-group")).toHaveText(["на сегодня · 2", "без срока · 1"]);
  await expect(page.locator("#tab-day .drawer-count")).toContainText("2 дела");
  await page.locator("#toast").getByRole("button", { name: "Вернуть" }).click();
  await expect(todo.locator(".day-group")).toHaveText(["на сегодня · 1", "без срока · 2"]);

  // Клавиши: J — к первому делу, E — готово; тост «Вернуть» кладёт обратно.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("j");
  await expect(todo.locator(".entry").first()).toBeFocused();
  const title = await todo.locator(".entry").first().locator(".entry-title").innerText();
  await page.keyboard.press("e");
  await expect(todo.locator(".entry").filter({ hasText: title })).toHaveCount(0);
  await expect(page.locator("#tab-journal b")).toHaveText("1");
  await expect(page.locator("#toast")).toContainText("Отмечено как готовое");
  // Закрытое видно во «Сделано» — и «Вернуть» кладёт его обратно в «День».
  await openTab(page, /^Сделано/);
  await expect(page.locator("#journal .entry").filter({ hasText: title })).toHaveCount(1);
  await openTab(page, /^День/);
  await page.locator("#toast").getByRole("button", { name: "Вернуть" }).click();
  await expect(todo.locator(".entry").filter({ hasText: title })).toHaveCount(1);
  await expect(page.locator("#tab-journal b")).toHaveText("0");
  // До строки запаса — теми же J, пока фокус не встанет на неё.
  const aiRow = todo.locator(".entry").filter({ hasText: "AI-инструменты" });
  for (let step = 0; step < 4 && !(await aiRow.evaluate((row) => row === document.activeElement)); step += 1) await page.keyboard.press("j");
  await expect(aiRow).toBeFocused();
  await page.keyboard.press("t");
  await expect(todo.locator(".day-group")).toHaveText(["на сегодня · 2", "без срока · 1"]);

  for (const response of created) await request.delete(`/api/captures/${response.entry.id}`);
});

// ── перенос не закрытого на завтра: полки «Дня» и вечерняя фраза обложки ──────
// День — по часам приложения (Самара), а не по UTC.
const zoneDay = (shift = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + shift * 86400000));
const scheduleById = async (request, id) => (await (await request.get(`/api/captures/${id}`)).json()).entry.interpretation.classification.entities.schedule;
// Пять дел: два просроченных (одно со временем), сегодняшнее, завтрашнее и ежедневное
// (его серию одной кнопкой не двигают).
async function postponeSetup(request) {
  const make = async (raw, due) => (await (await request.post("/api/captures", { data: { raw, due } })).json()).entry.id;
  const ids = {
    late: await make("Просроченный отчёт для переноса", { date: zoneDay(-1) }),
    lateTimed: await make("Просроченный звонок для переноса", { date: zoneDay(-3), time: "10:00" }),
    today: await make("Сегодняшнее дело для переноса", { date: zoneDay(0) }),
    tomorrow: await make("Завтрашнее дело для переноса", { date: zoneDay(1) }),
    daily: await make("Ежедневное дело для переноса", { date: zoneDay(0) }),
  };
  await request.post(`/api/captures/${ids.daily}/corrections`, { data: { at: Date.now(), patch: { schedule: { date: zoneDay(0), time: null, repeat: { freq: "daily", interval: 1 } } } } });
  return ids;
}

test("на полках «просрочено» и «на сегодня» — «перенести всё на завтра»: сроки уезжают, время остаётся, повтор на месте, «Вернуть» возвращает", async ({ page, request }) => {
  const ids = await postponeSetup(request);
  await page.goto("/");
  await openTab(page, /^День/);
  const todo = page.locator("#todo");
  // Подписи полок — по-прежнему свои элементы; ссылка стоит справа от подписи и у каждой полки своя.
  await expect(todo.locator(".day-group")).toHaveText(["просрочено · 2", "на сегодня · 2"]);
  const late = todo.locator(".day-head", { has: page.locator(".day-group.late") });
  const today = todo.locator(".day-head", { has: page.locator(".day-group.today") });
  await expect(late.locator(".day-head-act")).toHaveText("перенести всё на завтра");
  await expect(today.locator(".day-head-act")).toHaveText("перенести всё на завтра");
  await expect(late.locator(".day-head-act")).toHaveCSS("text-transform", "none");

  // Просроченные: оба на завтра, у второго остаётся 10:00; полка пропала, «Вернуть» кладёт сроки обратно.
  await late.locator(".day-head-act").click();
  await expect(page.locator("#toast")).toContainText("Перенесено на завтра: 2");
  await expect(todo.locator(".day-group.late")).toHaveCount(0);
  expect(await scheduleById(request, ids.late)).toMatchObject({ date: zoneDay(1) });
  expect(await scheduleById(request, ids.lateTimed)).toMatchObject({ date: zoneDay(1), time: "10:00" });
  await page.locator("#toast").getByRole("button", { name: "Вернуть" }).click();
  await expect(page.locator("#toast")).toContainText("Сроки вернулись");
  await expect(todo.locator(".day-group.late")).toHaveText("просрочено · 2");
  expect(await scheduleById(request, ids.late)).toMatchObject({ date: zoneDay(-1) });
  expect(await scheduleById(request, ids.lateTimed)).toMatchObject({ date: zoneDay(-3), time: "10:00" });

  // «На сегодня»: переносится только настоящее дело, ежедневное остаётся на месте.
  await todo.locator(".day-head", { has: page.locator(".day-group.today") }).locator(".day-head-act").click();
  await expect(page.locator("#toast")).toContainText("Перенесено на завтра: 1");
  expect(await scheduleById(request, ids.today)).toMatchObject({ date: zoneDay(1) });
  const daily = await scheduleById(request, ids.daily);
  expect(daily.date).toBe(zoneDay(0));
  expect(daily.repeat).toMatchObject({ freq: "daily" });
  // Завтрашнее не трогали.
  expect(await scheduleById(request, ids.tomorrow)).toMatchObject({ date: zoneDay(1) });
  // На полке остался один повтор — переносить нечего, ссылки нет.
  await expect(todo.locator(".day-group.today")).toHaveText("на сегодня · 1");
  await expect(todo.locator(".day-head-act.today")).toHaveCount(0);
});

test("вечером во фразе обложки «3 дела» и «перенести на завтра?» — кнопки: показать дела и перенести, «Вернуть» возвращает", async ({ page, request }) => {
  const today = zoneDay(0);
  test.skip([0, 6].includes(new Date(`${today}T12:00:00Z`).getUTCDay()), "по выходным обложка говорит про выходной, а не про вечер");
  const ids = await postponeSetup(request);
  // Вечер по часам приложения: 19:00 в Самаре.
  await page.clock.setSystemTime(new Date(`${today}T19:00:00+04:00`));
  await page.goto("/");
  const brief = page.locator("#today-brief");
  // Вечером открыт «Сделано»: свернули ящик — обложка на месте.
  await page.getByRole("tab", { name: /^Сделано/ }).click();
  await expect(brief).toBeVisible();
  await expect(page.locator("#today-date .today-phase")).toHaveText("вечер");
  // Не закрыто всё со сроком сегодня и раньше: два просроченных и сегодняшнее; ежедневное не в счёте.
  await expect(brief).toContainText("Не закрыто 3 дела со сроком — перенести на завтра?");
  await expect(brief.locator("button.linkish")).toHaveText(["3 дела", "перенести на завтра?"]);
  // Кнопка-ссылка того же цвета, что слово «вечер».
  const color = (locator) => locator.evaluate((element) => getComputedStyle(element).color);
  expect(await color(brief.locator("button.linkish").first())).toBe(await color(page.locator("#today-date .today-phase")));

  // «3 дела» открывает «День», ведёт к полке «просрочено» и подсвечивает строки, которые не закрыты.
  // Подсветка живёт секунду — за ней следит наблюдатель, а не опрос: под нагрузкой опрос её пропускает.
  await page.evaluate(() => {
    window.flashed = new Set();
    new MutationObserver((records) => {
      for (const record of records) if (record.target.classList.contains("flash")) window.flashed.add(record.target.dataset.captureId);
    }).observe(document.querySelector("#todo"), { attributes: true, attributeFilter: ["class"], subtree: true });
  });
  await brief.getByRole("button", { name: "3 дела" }).click();
  await expect(page.getByRole("tab", { name: /^День/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#todo .day-group.late")).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.flashed.size)).toBe(3);
  const flashed = await page.evaluate(() => [...window.flashed]);
  expect(flashed.sort()).toEqual([ids.late, ids.lateTimed, ids.today].sort());
  // Подсветка гаснет сама, строки на месте.
  await expect(page.locator("#todo .entry.flash")).toHaveCount(0, { timeout: 4000 });
  await expect(page.locator("#todo .entry").filter({ hasText: "Просроченный отчёт" })).toBeVisible();

  // «перенести на завтра?»: все три уезжают, время сохраняется, ежедневное и завтрашнее не тронуты.
  await page.getByRole("tab", { name: /^День/ }).click();
  await expect(brief).toBeVisible();
  const postpone = brief.getByRole("button", { name: "перенести на завтра?" });
  await postpone.click();
  await expect(page.locator("#toast")).toContainText("Перенесено на завтра: 3");
  expect(await scheduleById(request, ids.late)).toMatchObject({ date: zoneDay(1) });
  expect(await scheduleById(request, ids.lateTimed)).toMatchObject({ date: zoneDay(1), time: "10:00" });
  expect(await scheduleById(request, ids.today)).toMatchObject({ date: zoneDay(1) });
  expect((await scheduleById(request, ids.daily)).date).toBe(today);
  expect((await scheduleById(request, ids.tomorrow)).date).toBe(zoneDay(1));
  // Переносить нечего — фраза без кнопок.
  await expect(brief.locator("button.linkish")).toHaveCount(0);
  await expect(brief).not.toContainText("перенести на завтра");

  // «Вернуть» — прежние сроки теми же поправками, и фраза с кнопками возвращается.
  await page.locator("#toast").getByRole("button", { name: "Вернуть" }).click();
  await expect(page.locator("#toast")).toContainText("Сроки вернулись");
  expect(await scheduleById(request, ids.late)).toMatchObject({ date: zoneDay(-1) });
  expect(await scheduleById(request, ids.lateTimed)).toMatchObject({ date: zoneDay(-3), time: "10:00" });
  expect(await scheduleById(request, ids.today)).toMatchObject({ date: today });
  await expect(brief).toContainText("Не закрыто 3 дела со сроком — перенести на завтра?");
});
