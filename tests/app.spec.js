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
  // В шапке три двери и шестерёнка: Круги, Календарь, «?» и меню модели ушли.
  await expect(page.locator("header nav a")).toHaveText(["Сегодня", "Доска", "Заметки"]);
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
test("success notification disappears without shifting the lists under the field", async ({
  page,
}) => {
  await page.goto("/");
  const listsTop = await page.locator(".today-lists").evaluate((element) => element.getBoundingClientRect().top);
  await capture(page, "Завтра в 12 встреча по Hub");
  expect(await page.locator(".today-lists").evaluate((element) => element.getBoundingClientRect().top)).toBe(listsTop);
  await expect(page.locator("#capture-notifications .capture-notification")).toHaveCount(0, {
    timeout: 5000,
  });
  // Под полем два списка: «Сегодня» и «Что делал». Вкладок и ящиков нет.
  await expect(page.locator(".shelf-head")).toHaveText([/^Сегодня/, /^Что делал/]);
  await expect(page.locator(".drawer-tab, .daynav")).toHaveCount(0);
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
  // «Доработал X» — туду, закрытая сразу: она в «Что делал», не в «Сегодня».
  await expect(page.locator("#journal")).toContainText("доработал обновление контекста");
  await expect(page.locator("#todo")).not.toContainText("доработал обновление контекста");
  await capture(page, "Завтра в 11 созвон по Hub");
  // Завтрашнее дело живёт в завтрашнем дне, а не в сегодняшнем списке.
  await expect(page.locator("#todo")).not.toContainText("созвон по Hub");
  await capture(page, "Сегодня посмотрел работу с голосовым ИИ");
  // Любая запись — туду: даже наблюдение ложится в сегодняшний список.
  const entries = await (await page.request.get("/api/entries")).json();
  expect(entries.entries.some((entry) => entry.raw.includes("голосовым ИИ"))).toBe(true);
  await expect(page.locator("#todo, #journal").filter({ hasText: "голосовым ИИ" })).toHaveCount(1);
  await expect(page.locator(".shelf-head")).toHaveCount(2);
  expect(await page.locator("#attention, #today-notes, .drawer-tab").count()).toBe(0);
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

  // Дела живут в «Сегодня» обычными делами, а не строчками внутри чужой заметки.
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
  const source = page.locator("#journal .entry").filter({ hasText: "Созвонились по ВойсОпс" });
  await expect(source).toBeVisible();
  await source.locator(".entry-title").click();
  await expect(card.locator(".card-origin")).toContainText("Из этой записи 2 дела");
  await expect(card.locator(".card-origin")).toContainText("Допинываем карусель");
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

test("дата и бриф стоят над полем всегда, а полки идут под ним", async ({ page }) => {
  await page.goto("/");
  const brief = page.locator("#today-brief");
  const date = page.locator("#today-date");
  await expect(date).toBeVisible();
  await expect(brief).toBeVisible();
  await expect(brief).not.toHaveText("");
  const field = page.getByLabel("Новая запись");
  const top = async (locator) => (await locator.boundingBox()).y;
  expect(await top(date)).toBeLessThan(await top(field));
  expect(await top(field)).toBeLessThan(await top(page.locator("#shelf-today")));
  expect(await top(page.locator("#shelf-today"))).toBeLessThan(await top(page.locator("#journal")));
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
  // Наблюдение — тоже туду на сегодня, у него есть кружок.
  await expect(page.locator("#todo")).toContainText("голосовым ИИ");
  await expect(page.locator("#todo .completion-button").first()).toBeVisible();
  await expect(page.locator("#todo")).not.toContainText("созвон по Hub");
  expect(await page.locator(".calendar-block").count()).toBe(0);
  await expect(page.locator("#today-count")).toHaveText("2");
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
  // Просроченное стоит первым в общем списке, с чипом «со вчера», а не отдельной
  // полкой.
  await expect(firstTodo.locator(".tag.due.late")).toHaveText("со вчера");
  await expect(page.locator("#todo .day-group")).toHaveCount(0);
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
  // сегодня и в «Что делал» не попадает.
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
  // Закрытое дело уходит из «Сегодня» и встаёт в «Что делал» с временем закрытия.
  await expect(page.locator("#todo")).not.toContainText(raw);
  const closed = page.locator("#journal .entry").filter({ hasText: raw });
  await expect(closed).toHaveCount(1);
  await expect(closed.locator(".tag.time")).toHaveText(/^\d{2}:\d{2}$/);
  await page.screenshot({
    path: "tmp/screenshots/completion-ledger-fixture.png",
  });
  // Закрытие записано в данных, а не в состоянии страницы: переживает перезагрузку.
  await page.reload();
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
  await expect(
    page
      .locator("#todo .entry")
      .filter({ hasText: raw })
      .getByRole("button", { name: "Готово" }),
  ).toBeVisible();
  await page.reload();
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

test("в «Сегодня» дело — плотная строка без времени записи, в «Что делал» — со временем закрытия", async ({ page, request }) => {
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

  // «Сделали X» — туду, закрытая при записи: в «Что делал» она строкой с
  // временем закрытия, а не временем записи с днём.
  const done = await request.post("/api/captures", { data: { raw: "Сделали разбор по Hub" } });
  await page.reload();
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
  await expect(page.locator("#review-dialog .side-quiet")).toContainText(/Поле записи · сегодня, \d{2}:\d{2}/);
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

test("«Сегодня» — один список: просрочка, потом часы, потом дела без часа", async ({
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
    { raw: "прибраться в заметках" },
    { raw: "созвон с командой", due: { date: day(0), time: "16:30" } },
    { raw: "сдать отчёт", due: { date: day(-3) } },
  ])
    created.push(await request.post("/api/captures", { data }));

  const todo = page.locator("#todo");
  await expect(todo.locator(".entry")).toHaveCount(3, { timeout: 15000 });
  // Порядок и есть ответ на «что я вижу первым»: просроченное, потом строки с
  // часом (перед ними — «сейчас»), потом дела без часа. Заголовков-полок внутри
  // списка нет.
  await expect(todo.locator(".entry")).toContainText([/сдать отчёт/, /созвон с командой/, /прибраться в заметках/]);
  await expect(todo.locator(".day-group")).toHaveCount(0);
  await expect(page.locator("#today-count")).toHaveText("3");
  await expect(todo.locator(".now-mark")).toHaveCount(1);

  const late = todo.locator(".entry.overdue");
  await expect(late).toHaveCount(1);
  await expect(late).toContainText("сдать отчёт");
  await expect(late).not.toContainText("просрочено");

  // Плотная строка: ни «задача», ни «без срока», ни времени записи.
  const row = todo.locator(".entry").last();
  await expect(row).toHaveClass(/dense/);
  await expect(row).not.toContainText("без срока");
  await expect(row).not.toContainText("задача");

  // У дела в его же часе срок не повторяется — время слева уже сказано.
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

test("future-dated todos wait for their day: not in «Сегодня», on the board", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  for (const name of ["первое дело", "второе дело", "третье дело"])
    await request.post("/api/captures", {
      data: { raw: name, due: { date: "2026-12-31" }, priority: "high", tags: ["первый", "второй", "третий"] },
    });
  for (const name of ["раз", "два", "три", "четыре", "пять", "шесть", "семь"])
    await request.post("/api/captures", { data: { raw: `Обсудили ${name}` } });
  // Семь «Обсудили …» — закрытые сразу туду: «Что делал» показывает все. Дел на
  // декабрь в сегодняшнем списке нет и хвоста «Ещё N» тоже.
  await expect(page.locator("#journal .entry:visible")).toHaveCount(7, { timeout: 15000 });
  expect(await page.locator("#todo .entry").count()).toBe(0);
  await expect(page.locator("#todo .preview-more")).toHaveCount(0);
  await expect(page.locator("#todo")).toContainText("Открытых дел нет");
  await expect(page.locator("#done-count")).toHaveText("7");
  // Будущие дела лежат на доске.
  await page.locator('nav a[href="#board"]').click();
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator("#board-columns .board-card").filter({ hasText: /первое|второе|третье/ })).toHaveCount(3);
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




test("«Сегодня» закрывается с клавиатуры: J идёт по делам, E закрывает, «Вернуть» возвращает", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const today = (await (await request.get("/api/day")).json()).date;
  const created = [];
  for (const data of [
    { raw: "проработать тему путешествий", due: { date: today } },
    { raw: "потыкать новые AI-инструменты" },
    { raw: "собрать дни рождения команды" },
  ])
    created.push(await (await request.post("/api/captures", { data })).json());
  await page.goto("/");
  const todo = page.locator("#todo");
  await expect(todo.locator(".entry")).toHaveCount(3, { timeout: 15000 });
  await expect(page.locator("#today-count")).toHaveText("3");
  // Без срока не бывает: всё, что записано, лежит на сегодня одним списком.
  await expect(todo.locator(".day-group, .quick-due")).toHaveCount(0);

  // Клавиши: J — к первому делу, E — готово; тост «Вернуть» кладёт обратно.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("j");
  await expect(todo.locator(".entry").first()).toBeFocused();
  const title = await todo.locator(".entry").first().locator(".entry-title").innerText();
  await page.keyboard.press("e");
  await expect(todo.locator(".entry").filter({ hasText: title })).toHaveCount(0);
  await expect(page.locator("#journal .entry").filter({ hasText: title })).toHaveCount(1);
  await expect(page.locator("#today-count")).toHaveText("2");
  await expect(page.locator("#done-count")).toHaveText("1");
  await expect(page.locator("#toast")).toContainText("Отмечено как готовое");
  await page.locator("#toast").getByRole("button", { name: "Вернуть" }).click();
  await expect(todo.locator(".entry").filter({ hasText: title })).toHaveCount(1);
  await expect(page.locator("#journal .entry")).toHaveCount(0);
  await expect(page.locator("#journal")).toContainText("Пока ничего. Первый кружок — сюда.");

  for (const response of created) await request.delete(`/api/captures/${response.entry.id}`);
});
