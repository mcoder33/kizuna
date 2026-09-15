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
// Дела и встречи на другой день живут в своём дне: стрелки по дням внутри
// ящика «День». Смещение считается от сегодняшнего дня.
async function showDay(page, offset) {
  const back = page.locator('#todo .daynav [data-view="0"]');
  if (await back.count()) await back.click();
  const step = page.locator(`#todo .daynav [data-step="${offset > 0 ? 1 : -1}"]`);
  for (let i = 0; i < Math.abs(offset); i += 1) await step.click();
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
  // В шапке остались обе двери: быстрый выбор модели и шестерёнка во все
  // настройки.
  await expect(page.locator("#ai-summary")).toHaveText("fast");
  await expect(page.locator(".settings-link")).toHaveAttribute("href", "#settings");
  await page.locator(".ai-menu summary").click();
  await expect(page.getByText("Выбран: OpenRouter")).toBeVisible();
  await expect(page.locator(".ai-menu-more")).toHaveAttribute("href", "#settings");
  await page.locator(".ai-menu summary").click();
  await capture(page, "Завтра в 11 созвон по Hub");
  await expect(page.locator("#capture-notifications")).toContainText("Готово");
  await showDay(page, 1);
  await expect(page.locator("#todo")).toContainText("созвон по Hub");
  await page.screenshot({ path: "tmp/screenshots/async-capture-ready.png" });
});
test("medium-confidence Codex classification remains visible in Plan", async ({ page }) => {
  await page.goto("/");
  await page.locator(".ai-menu summary").click();
  await page.getByLabel("Провайдер ИИ").selectOption("codex-cli");
  await capture(page, "Завтра в 11 созвон по Hub");
  // Заглушка Codex не разбирает срок: встреча без даты лежит в сегодняшнем дне.
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
  // Под полем два ящика: «Что делал» и «День». Колонок и заметок больше нет.
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
test("today separates reported work and the day's plan; notes stay off the main page", async ({
  page,
}) => {
  await page.goto("/");
  await capture(page, "доработал обновление контекста для Hub");
  await expect(page.locator("#journal")).toContainText(
    "доработал обновление контекста",
  );
  await capture(page, "Завтра в 11 созвон по Hub");
  // Завтрашняя встреча живёт в завтрашнем дне, а не в сегодняшнем списке.
  await expect(page.locator("#todo")).not.toContainText("созвон по Hub");
  await showDay(page, 1);
  await expect(page.locator("#todo")).toContainText("созвон по Hub");
  await showDay(page, 0);
  // Заметка сохраняется, но на главную не выносится: главная — про день.
  await capture(page, "Сегодня посмотрел работу с голосовым ИИ");
  await expect(page.locator("#journal")).not.toContainText("голосовым ИИ");
  await expect(page.locator("#todo")).not.toContainText("голосовым ИИ");
  const entries = await (await page.request.get("/api/entries")).json();
  expect(entries.entries.some((entry) => entry.raw.includes("голосовым ИИ"))).toBe(true);
  await expect(page.getByRole("tab", { name: /Что делал/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /День/ })).toBeVisible();
  expect(await page.locator("#notes").count()).toBe(0);
  expect(await page.locator("#attention").count()).toBe(0);
  await page.evaluate(() => { location.hash = "#memory"; });
  await expect(page.locator("#memory")).toBeVisible();
  await expect(page.locator("#today")).toBeHidden();
});
// Бриф и список не говорят одно и то же: рассказ виден, только пока оба ящика
// закрыты. Днём фаза открывает «День», поэтому страница встречает списком.
test("бриф пропадает при раскрытом ящике и возвращается, когда всё свёрнуто", async ({ page }) => {
  await page.goto("/");
  const brief = page.locator("#today-brief");
  const dayTab = page.getByRole("tab", { name: /^День/ });
  const journalTab = page.getByRole("tab", { name: /Что делал/ });
  await expect(dayTab).toHaveAttribute("aria-selected", "true");
  await expect(brief).toBeHidden();
  // Свернули — бриф вернулся на своё место, над полем ввода.
  await dayTab.click();
  await expect(brief).toBeVisible();
  await expect(brief).not.toHaveText("");
  // Соседний ящик прячет его так же.
  await journalTab.click();
  await expect(brief).toBeHidden();
  await journalTab.click();
  await expect(brief).toBeVisible();
});
// Стрелки уводят ящик в другой день, но переключение ящика — всегда «сегодня»:
// закрыли, открыли соседний или вернулись — оба дня сегодняшние.
test("переключение ящика возвращает оба дня на сегодня", async ({ page }) => {
  await page.goto("/");
  const dayTab = page.getByRole("tab", { name: /^День/ });
  const journalTab = page.getByRole("tab", { name: /Что делал/ });
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
  await expect(journalLabel).toHaveText("Что делал");
  await expect(dayLabel).toHaveText("День");

  // Теперь в другой день ушёл «Что делал» — и вернулся, когда открыли «День».
  await page.locator('#journal .daynav [data-step="-1"]').click();
  await expect(journalLabel).not.toHaveText("Что делал");
  await dayTab.click();
  await expect(dayToday).toBeVisible();
  await expect(journalLabel).toHaveText("Что делал");

  // Закрыли ящик — открытый снова показывает сегодня, а не тот день.
  await page.locator('#todo .daynav [data-step="1"]').click();
  await expect(dayToday).toHaveCount(0);
  await dayTab.click();
  await expect(page.locator("#todo")).toBeHidden();
  await expect(dayLabel).toHaveText("День");
  await dayTab.click();
  await expect(dayToday).toBeVisible();
});
test("the day keeps tasks and meetings together; notes never land among them", async ({
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
  await expect(page.locator("#todo")).not.toContainText("голосовым ИИ");
  await expect(
    page.locator("#todo .completion-button").first(),
  ).toBeVisible();
  await showDay(page, 1);
  await expect(page.locator("#todo")).toContainText(meeting);
  await expect(page.locator("#todo")).not.toContainText("голосовым ИИ");
  expect(await page.locator("#notes").count()).toBe(0);
  expect(await page.locator(".calendar-block").count()).toBe(0);
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
  await expect(firstTodo).toContainText("просрочено");
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
test("completed reports, including ready wording, are Done while negated reports remain notes", async ({
  page,
}) => {
  const completed = "Готово: обсудили план по Hub";
  const negated = "Ничего не сделал по Hub";
  await page.goto("/");
  await capture(page, completed);
  await expect(page.locator("#journal")).toContainText(completed);
  await expect(page.locator("#todo")).not.toContainText(completed);
  await capture(page, negated);
  // Отрицание — заметка: её нет ни в сделанном, ни в делах дня.
  await expect(page.locator("#journal")).not.toContainText(negated);
  await expect(page.locator("#todo")).not.toContainText(negated);
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
  await expect(page.locator("#review-primary-type")).toBeVisible();
  await expect(page.locator(".review-confidence")).toBeHidden();
});
test("user completion survives reload, is single-flight, and undo returns a meeting to work", async ({
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
  // Закрытая задача уходит с «Сегодня» и не попадает в дневник «Что делал»:
  // дневник — это записи-отчёты, а закрытие задачи не отчёт.
  await expect(page.locator("#todo")).not.toContainText(raw);
  await expect(page.locator("#journal")).not.toContainText(raw);
  await page.screenshot({
    path: "tmp/screenshots/completion-ledger-fixture.png",
  });
  // Закрытая встреча лежит хвостом списка дел в «Закрытых» и переживает
  // перезагрузку — закрытие записано в данных, а не в состоянии страницы.
  await page.goto("/#board?view=list");
  const closedCard = page
    .locator("#board-columns .board-column.closed .board-card")
    .filter({ hasText: raw })
    .first();
  await expect(closedCard).toBeVisible();
  await page.reload();
  await expect(closedCard).toBeVisible();
  const entries = await (await page.request.get("/api/entries")).json(),
    entry = entries.entries.find((candidate) => candidate.raw === raw),
    projection = entry.projections.find(
      (candidate) => candidate.type === "meeting_event",
    );
  expect(projection.completion.completed).toBe(true);
  // Двойной щелчок по «Вернуть в работу» — один запрос: кнопка гаснет сразу.
  await closedCard
    .getByRole("button", { name: /Вернуть в работу/ })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(page.locator("#board-columns .board-column.closed")).toHaveCount(0);
  await page.goto("/#today");
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
  await page.goto("/");
  await page.locator(".ai-menu summary").click();
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
  await page.locator(".ai-menu summary").click();
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
test("correction from an upcoming card after reload is single-flight", async ({
  page,
}) => {
  const raw = "Завтра в 11 созвон по Hub";
  await page.goto("/");
  await capture(page, raw);
  await page.reload();
  await showDay(page, 1);
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
  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  await page.locator("#review-project").fill("Свой проект");
  // Кнопки «сохранить» нет: свойства уходят при закрытии карточки. Второй
  // клик по крестику попадает в уже закрывающуюся карточку — уточнение одно.
  await page.locator("#review-close").evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page.locator("#todo")).toContainText("Свой проект");
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
  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  await page.locator("#review-project").fill("Attention проект");
  await page.locator("#review-close").evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page.locator("#todo")).toContainText("Attention проект");
  const entries = await (await page.request.get("/api/entries")).json(),
    entry = entries.entries.find((candidate) => candidate.raw === raw);
  expect(entry.interpretation.version).toBe(2);
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
  const raw = "Завтра в 11 созвон с Илья по Hub";
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
  await showDay(page, 1);
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
  // На пустом поле главное действие — разговор: кнопка отправки появляется
  // только вместе с текстом, поэтому на свежей странице ждём именно эту.
  await expect(
    page.getByRole("button", { name: "Поговорить с журналом" }),
  ).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    /^data:image\/svg\+xml/,
  );
  await page.goto("/prototype.html");
  await expect(page.locator("body")).toBeVisible();
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
  await expect(page.locator("#todo .empty")).toBeVisible();

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

// Карточка отвечает на «когда это было» и «к чему относится»: время записи
// видно всегда, срок и проект — когда они есть.
test("карточка показывает время записи, срок и проект", async ({ page, request }) => {
  await page.goto("/");
  const created = await request.post("/api/captures", {
    data: {
      raw: "созвон по Hub",
      primaryType: "todo",
      due: { date: "2026-08-27", time: "11:00" },
    },
  });
  expect(created.status()).toBe(201);
  const entry = page.locator("#todo .entry").filter({ hasText: "созвон по Hub" }).first();
  await expect(entry).toBeVisible({ timeout: 15000 });

  // Время записи — всегда, с днём: «сегодня, 13:57», а не голые часы.
  await expect(entry.locator(".entry-meta")).toContainText(/сегодня, \d{2}:\d{2}/);
  // Срок назван сроком, а не просто датой рядом с типом.
  await expect(entry.locator(".entry-meta")).toContainText("срок:");
  // Проект — отдельной меткой.
  await expect(entry.locator(".entry-meta .tag.project")).toHaveText("Hub");

  await request.delete(`/api/captures/${(await created.json()).entry.id}`);
});

// Просрочено или нет должно быть видно на карточке, а не вычисляться в уме:
// у дела со сроком — состояние, у дела без срока — прямое «без срока».
test("карточка говорит, просрочено дело или нет", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");

  // Сроки берём рядом с сегодняшним днём: далёкие даты приложение не принимает,
  // а разбег в три дня переживает любой часовой пояс.
  const day = (shift) => {
    const at = new Date();
    at.setDate(at.getDate() + shift);
    return at.toISOString().slice(0, 10);
  };
  const late = await request.post("/api/captures", {
    data: { raw: "сдать отчёт", primaryType: "todo", due: { date: day(-3) } },
  });
  const soon = await request.post("/api/captures", {
    data: { raw: "созвон по релизу", primaryType: "todo", due: { date: day(3) } },
  });
  const undated = await request.post("/api/captures", {
    data: { raw: "купить кофе", primaryType: "todo" },
  });

  const card = (text) => page.locator("#todo .entry").filter({ hasText: text }).first();
  await expect(card("сдать отчёт")).toBeVisible({ timeout: 15000 });
  await expect(card("сдать отчёт")).toHaveClass(/overdue/);
  // Красным помечены обе половины: и сам срок, и слово «просрочено».
  await expect(card("сдать отчёт").locator(".tag.due.late")).toContainText("срок:");
  await expect(card("сдать отчёт").locator(".tag.late:not(.due)")).toHaveText("просрочено");

  // Без срока просрочки быть не может — и это сказано словами, а не пустотой.
  await expect(card("купить кофе").locator(".tag.undated")).toHaveText("без срока");

  // Дело со сроком через три дня живёт в своём дне полосы дней, а не в сегодняшнем.
  await expect(page.locator("#todo")).not.toContainText("созвон по релизу");
  await showDay(page, 3);
  await expect(card("созвон по релизу").locator(".tag.ontime")).toHaveText("в срок");
  await expect(card("созвон по релизу").locator(".tag.late")).toHaveCount(0);
  await expect(card("созвон по релизу")).not.toHaveClass(/overdue/);
  await showDay(page, 0);

  // В самой карточке видно, когда запись сделана.
  await card("купить кофе").locator(".entry-title").click();
  await expect(page.locator(".card-written")).toContainText(/Записано: сегодня, \d{2}:\d{2}/);
  // И ни одной подчёркнутой кнопки: подчёркивание читалось как ссылка.
  const underlined = await page.evaluate(() =>
    [...document.querySelectorAll("#review-dialog button, #review-dialog a")].filter((node) =>
      getComputedStyle(node).textDecorationLine.includes("underline"),
    ).length,
  );
  expect(underlined).toBe(0);
  await page.locator("#review-close").click();

  for (const response of [late, soon, undated])
    await request.delete(`/api/captures/${(await response.json()).entry.id}`);
});

// Колонка на «Сегодня» показывает только первые записи. Раньше об этом было
// сказано лишь заголовком-ссылкой: дело, которому передвинули срок вперёд,
// уходило за границу превью и выглядело пропавшим — «не сохранилось».
test("колонка честно говорит, сколько записей осталось за границей превью", async ({
  page,
  request,
}) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");

  const created = [];
  for (const name of ["первое дело", "второе дело", "третье дело", "четвёртое дело"])
    created.push(
      await request.post("/api/captures", { data: { raw: name, primaryType: "todo" } }),
    );

  const todo = page.locator("#todo");
  // Запас сверх трёх лежит в DOM скрытым — считаются видимые карточки.
  await expect(todo.locator(".entry:visible")).toHaveCount(3, { timeout: 15000 });
  const more = todo.locator(".preview-more");
  await expect(more).toHaveText("Ещё 1 — весь список →");
  await expect(more).toHaveAttribute("href", "#board?view=list");

  // Полный список — доска списком, открывается по этой же ссылке, и там все четыре.
  await more.click();
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator("#board-columns")).toHaveClass(/list/);
  await expect(page.locator("#board-columns .board-card")).toHaveCount(4);

  for (const response of created)
    await request.delete(`/api/captures/${(await response.json()).entry.id}`);
});

// Дела на другие дни живут в своих днях: в сегодняшнем списке их нет, но хвост
// «Ещё N» их считает, а «Что делал» показывает всё записанное за день.
test("future-dated tasks stay in their days while the tail counts them", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.goto("/");
  for (const name of ["первое дело", "второе дело", "третье дело"])
    await request.post("/api/captures", {
      data: { raw: name, primaryType: "todo", due: { date: "2026-12-31" }, priority: "high", tags: ["первый", "второй", "третий"] },
    });
  for (const name of ["раз", "два", "три", "четыре", "пять", "шесть", "семь"])
    await request.post("/api/captures", { data: { raw: `Обсудили ${name}`, primaryType: "outcome" } });
  await expect(page.locator("#todo .preview-more")).toHaveText("Ещё 3 — весь список →", { timeout: 15000 });
  expect(await page.locator("#todo .entry").count()).toBe(0);
  await page.getByRole("tab", { name: /Что делал/ }).click();
  await expect(page.locator("#journal .entry:visible")).toHaveCount(7, { timeout: 15000 });
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

  // Меняем поведение разговора и вид журнала.
  await page.locator("#setting-sleepAfterSeconds").fill("60");
  await page.locator("#setting-wakeWord").fill("журнал");
  await page.locator("#setting-previewLimit").fill("5");
  await page.locator("#setting-previewLimit").blur();
  await expect(page.locator("#settings-status")).toHaveText("Сохранено");

  // Сохранилось на сервере само, без кнопки, — и не только на экране.
  await expect
    .poll(async () => {
      const saved = (await (await request.get("/api/settings")).json()).settings;
      return [saved.sleepAfterSeconds, saved.wakeWord, saved.previewLimit].join("|");
    })
    .toBe("60|журнал|5");

  // Колонка сразу показывает пять записей вместо трёх — без перезагрузки.
  const created = [];
  for (const name of ["дело 1", "дело 2", "дело 3", "дело 4", "дело 5", "дело 6"])
    created.push(await request.post("/api/captures", { data: { raw: name, primaryType: "todo" } }));
  await page.locator('nav a[href="#today"]').click();
  await expect(page.locator("#todo .entry:visible")).toHaveCount(5, { timeout: 15000 });
  await expect(page.locator("#todo .preview-more")).toHaveText("Ещё 1 — весь список →");

  // Новое слово пробуждения видно в подсказке разговора.
  await page.locator("#capture-voice").click();
  await expect(page.locator("#voice-hint")).toContainText("Ключа нет");

  // Возвращаем как было и убираем записи.
  await request.put("/api/settings", {
    data: { sleepAfterSeconds: "", wakeWord: "", previewLimit: "" },
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

// Голос выбирается списком, а не набирается руками: от него зависит род, в
// котором модель говорит о себе, и произвольная строка это согласование ломала.
test("голос выбирается из списка, а добавка к промпту дописывается к основному", async ({
  page,
  request,
}) => {
  await page.goto("/#settings");
  const gemini = page.locator("#setting-geminiVoiceName");
  await expect(gemini).toBeVisible();
  // В списке видно и имя, и род — выбирают осознанно.
  await expect(gemini.locator("option")).toContainText([/Puck — мужской/, /Charon — мужской/]);
  await expect(page.locator("#setting-voiceName option").first()).toContainText("Marin — женский");

  // Род берётся у голоса того провайдера, которым разговор идёт сейчас. В этом
  // прогоне ключей нет, поэтому проверяем голос OpenAI — он и считается
  // действующим.
  await gemini.selectOption("Charon");
  await page.locator("#setting-voiceName").selectOption("cedar");
  // Поле предзаполнено характером Кизуны по умолчанию.
  await expect(page.locator("#setting-systemPrompt")).toHaveValue(/японским акцентом/);
  await page.locator("#setting-systemPrompt").fill("Отвечай короче и по делу.");
  await page.locator("#setting-systemPrompt").blur();

  // Настройки ушли сами; ждём, пока последняя долетит до инструкций.
  await expect
    .poll(async () => (await (await request.get("/api/voice/status")).json()).instructions)
    .toContain("От человека: Отвечай короче и по делу.");
  const voice = await (await request.get("/api/voice/status")).json();
  expect(voice.instructions).toContain("мужским голосом");
  // Основные правила разговора добавка не отменяет.
  expect(voice.instructions).toContain("Кизуна");

  // Женский голос меняет род, а не дописывает вторую строку.
  await page.locator("#setting-voiceName").selectOption("sage");
  await expect
    .poll(async () => (await (await request.get("/api/voice/status")).json()).instructions)
    .toContain("женским голосом");
  const female = await (await request.get("/api/voice/status")).json();
  expect(female.instructions).not.toContain("мужским голосом");

  await request.put("/api/settings", {
    data: { geminiVoiceName: "", voiceName: "", systemPrompt: "" },
  });
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

// Одна кнопка на два дела, как в разговорных приложениях: пока писать нечего —
// это разговор, появился текст — отправка. Проверяется не картинка, а то, что в
// каждый момент на месте ровно одна кнопка и она делает то, что обещает.
test("кнопка в углу поля меняется: разговор на пустом, отправка на наборе", async ({ page }) => {
  await page.goto("/");
  const voice = page.getByRole("button", { name: "Поговорить с журналом" });
  const submit = page.getByRole("button", { name: "Сохранить запись" });

  await expect(voice).toBeVisible();
  await expect(submit).toBeHidden();

  await page.getByLabel("Новая запись").fill("купить кофе");
  await expect(submit).toBeVisible();
  await expect(voice).toBeHidden();

  // Обе занимают одно место: иначе кнопка прыгала бы на глазах у человека.
  const submitBox = await submit.boundingBox();
  await page.getByLabel("Новая запись").fill("");
  await expect(voice).toBeVisible();
  const voiceBox = await voice.boundingBox();
  expect(Math.round(voiceBox.x)).toBe(Math.round(submitBox.x));
  expect(Math.round(voiceBox.width)).toBe(Math.round(submitBox.width));

  // Одни пробелы — ещё не запись.
  await page.getByLabel("Новая запись").fill("   ");
  await expect(voice).toBeVisible();
  await expect(submit).toBeHidden();
});

// Значок на кнопке рисуется вручную путями, и однажды он уже уехал: полосы
// стояли с разным шагом, а вся волна — правее центра. Проверяется геометрия, а
// не картинка: центр краски должен совпадать с центром кнопки.
test("волна на кнопке разговора стоит ровно по центру круга", async ({ page }) => {
  await page.goto("/");
  const geometry = await page.evaluate(() => {
    const button = document.querySelector("#capture-voice");
    const paths = [...button.querySelectorAll("path")];
    const stroke = parseFloat(getComputedStyle(paths[0]).strokeWidth);
    const boxes = paths.map((path) => path.getBoundingClientRect());
    const button_ = button.getBoundingClientRect();
    const ink = {
      left: Math.min(...boxes.map((box) => box.left)) - stroke / 2,
      right: Math.max(...boxes.map((box) => box.right)) + stroke / 2,
      top: Math.min(...boxes.map((box) => box.top)) - stroke / 2,
      bottom: Math.max(...boxes.map((box) => box.bottom)) + stroke / 2,
    };
    return {
      сдвигX: (ink.left + ink.right) / 2 - (button_.left + button_.right) / 2,
      сдвигY: (ink.top + ink.bottom) / 2 - (button_.top + button_.bottom) / 2,
      доля: (ink.right - ink.left) / button_.width,
      // Шаг между полосами должен быть одинаковым: разный читается как «криво».
      шаги: boxes
        .map((box) => box.left)
        .sort((left, right) => left - right)
        .slice(1)
        .map((value, index, all) => value - boxes.map((box) => box.left).sort((a, b) => a - b)[index]),
      круглая: getComputedStyle(button).borderRadius,
      квадратная: Math.abs(button_.width - button_.height) < 0.5,
    };
  });

  expect(Math.abs(geometry.сдвигX)).toBeLessThan(0.5);
  expect(Math.abs(geometry.сдвигY)).toBeLessThan(0.5);
  expect(geometry.квадратная).toBe(true);
  expect(geometry.круглая).toBe("50%");
  // Волна заполняет круг, а не теряется в нём.
  expect(geometry.доля).toBeGreaterThan(0.4);
  expect(geometry.доля).toBeLessThan(0.6);
  const шаг = geometry.шаги[0];
  for (const value of geometry.шаги) expect(Math.abs(value - шаг)).toBeLessThan(0.5);
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
  await drag("s", 0, 40);
  expect(Math.round(await height())).toBe(Math.round(startHeight + 40));
  await page.reload();
  expect(Math.round(await width())).toBe(Math.round(startWidth + 120));
  expect(Math.round(await height())).toBe(Math.round(startHeight + 40));
  // Левый край уменьшает ширину, если тянуть внутрь.
  await drag("w", 30, 0);
  expect(Math.round(await width())).toBe(Math.round(startWidth + 60));
  await page.locator('#capture-form .capture-resize[data-dir="se"]').dblclick();
  expect(Math.round(await width())).toBe(Math.round(startWidth));
  expect(Math.round(await height())).toBe(Math.round(startHeight));
});
