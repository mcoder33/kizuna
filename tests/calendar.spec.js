import { test, expect } from "@playwright/test";
import { E2E_EMAIL } from "./fixtures/e2e-account.js";

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
  // Просроченное — за неделей: срок внутри показанной недели встаёт в свой день,
  // а в полосу сегодняшнего дня попадает только то, что раньше неё. С «сегодня
  // минус три» тест падал с четверга по воскресенье.
  await request.post("/api/captures", { data: { raw: "Написать Антону Гришину по внедрению", primaryType: "todo", due: { date: shift(monday, -1) } } });

  await page.goto("/#calendar");
  await page.evaluate(() => { localStorage.setItem("kizuna-calendar-mode", "week"); });
  await page.reload();
  const calendar = page.locator("#calendar-view");
  await expect(calendar).toBeVisible();
  // Страница открывается по адресу, а в шапке ей пункта нет: ни один не активен.
  await expect(page.locator("nav a")).toHaveText(["Сегодня", "Доска", "Заметки"]);
  await expect(page.locator("nav a.active")).toHaveCount(0);
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
  const quick = page.locator(".cal-pop.quick input");
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

// Плашка чужого события как в Календаре macOS: календарь, откуда, когда и
// повтор, участники с ответами, ссылки, мой ответ. Событие кладётся прямо в
// базу прогона: CalDAV-сервера у e2e нет, а плашка читает только кэш.
test("плашка чужого события: участники с ответами, повтор, ссылки и мой ответ организатору", async ({ page, request }) => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database("/tmp/pagent-e2e.sqlite");
  // Именно e2e-учётка: другие спеки регистрируют ещё пользователей, и «первый
  // попавшийся» в полном прогоне оказывался чужим — события не показывались.
  const user = db.prepare("SELECT id FROM users WHERE email=?").get(E2E_EMAIL);
  db.prepare("DELETE FROM calendar_events").run();
  db.prepare("DELETE FROM calendar_accounts").run();
  db.prepare("INSERT INTO calendar_accounts(id,user_id,provider,preset,label,color,mode,server_url,username,credentials_enc,calendars_json,synced_at,created_at,auto_export) VALUES('acc1',?,'caldav','yandex','Яндекс','#3b82f6','full','https://caldav.yandex.ru','me@itfinance.tech','v1.x',?,datetime('now'),datetime('now'),'off')")
    .run(user.id, JSON.stringify([{ id: "c1", url: "https://caldav.yandex.ru/c1/", name: "Itfinance", color: "#3b82f6", selected: true, writable: true }, { id: "c2", url: "https://caldav.yandex.ru/c2/", name: "Личное", color: "#ff8a00", selected: true, writable: true }]));
  const attendees = [
    { email: "stas@itfinance.tech", name: "Станислав Косухин", status: "accepted", optional: false, organizer: true },
    { email: "a.m@itfinance.tech", name: "Анастасия Мжельская", status: "declined", optional: false, organizer: false },
    { email: "g@itfinance.tech", name: "Гончар Александр", status: "needs-action", optional: false, organizer: false },
    { email: "me@itfinance.tech", name: "Александр Марченков", status: "accepted", optional: true, organizer: false },
  ];
  // День — по часам приложения (Самара), а не по UTC: поздним вечером они расходятся.
  const today = (await (await request.get("/api/day")).json()).date;
  db.prepare("INSERT INTO calendar_events(id,account_id,calendar_id,uid,instance_key,title,description,location,start_at,end_at,all_day,busy,join_url,etag,href,updated_at,attendees_json,organizer_json,repeat,url,sequence) VALUES('e1','acc1','c1','u1',NULL,'Монетизация ZB по понедельникам',NULL,NULL,?,?,0,1,'https://telemost.360.yandex.ru/j/0319350436','\"e\"','https://calendar.yandex.ru/event?event_id=2916085540',datetime('now'),?,?,'Повторяется каждую неделю по пн','https://calendar.yandex.ru/event?event_id=2916085540',3)")
    .run(`${today}T13:30:00.000Z`, `${today}T14:30:00.000Z`, JSON.stringify(attendees), JSON.stringify({ email: "stas@itfinance.tech", name: "Станислав Косухин" }));
  // Экземпляр повтора (instance_key) — у него «Удалить» спрашивает про серию.
  db.prepare("INSERT INTO calendar_events(id,account_id,calendar_id,uid,instance_key,title,description,location,start_at,end_at,all_day,busy,join_url,etag,href,updated_at,repeat,sequence) VALUES('e2','acc1','c1','u2',?,'Ретро команды',NULL,NULL,?,?,0,1,NULL,'\"r\"','https://calendar.yandex.ru/event?event_id=1',datetime('now'),'Повторяется каждую неделю по пн',1)")
    .run(`${today}T15:30:00.000Z`, `${today}T15:30:00.000Z`, `${today}T16:30:00.000Z`);
  // Приглашение, на которое я не ответил: в сетке его видно и без плашки.
  db.prepare("INSERT INTO calendar_events(id,account_id,calendar_id,uid,instance_key,title,start_at,end_at,all_day,busy,etag,href,updated_at,attendees_json,organizer_json,sequence) VALUES('e3','acc1','c1','u3',NULL,'Аналитика ЗБ по ИИ',?,?,0,1,'\"a\"','https://calendar.yandex.ru/event?event_id=3',datetime('now'),?,?,1)")
    .run(`${today}T09:00:00.000Z`, `${today}T10:00:00.000Z`,
      JSON.stringify([
        { email: "stas@itfinance.tech", name: "Станислав Косухин", status: "accepted", optional: false, organizer: true },
        { email: "me@itfinance.tech", name: "Александр Марченков", status: "needs-action", optional: false, organizer: false },
      ]),
      JSON.stringify({ email: "stas@itfinance.tech", name: "Станислав Косухин" }));
  db.close();
  await page.goto("/#calendar");
  await page.evaluate(() => { localStorage.setItem("kizuna-calendar-mode", "day"); });
  await page.reload();
  await page.locator(".cal-ev.external", { hasText: "Монетизация" }).first().click();
  const pop = page.locator(".cal-pop.rich");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".cal-pop-title")).toHaveText("Монетизация ZB по понедельникам");
  await expect(pop.locator(".pop-cal select")).toHaveValue("c1");
  await expect(pop.locator(".pop-src")).toHaveText("Яндекс · calendar.yandex.ru");
  await expect(pop.locator(".pop-when")).toContainText("17:30 – 18:30");
  await expect(pop.locator(".pop-repeat")).toContainText("Повторяется каждую неделю по пн");
  await expect(pop.locator(".pop-person")).toHaveCount(4);
  await expect(pop.locator(".pop-person").nth(0)).toContainText(/Станислав Косухин\s*\(организатор\)/);
  await expect(pop.locator(".pop-person").nth(1).locator(".pop-st")).toHaveClass(/declined/);
  // Кто не ответил — не серый: иначе «кого ещё ждём» вычитывается по значкам.
  const waiting = pop.locator(".pop-person").nth(2).locator(".pop-st");
  await expect(waiting).toHaveClass(/needs-action/);
  const waitingLook = await waiting.evaluate((element) => ({
    color: getComputedStyle(element).color,
    border: getComputedStyle(element).borderTopStyle,
    name: getComputedStyle(element.parentElement.querySelector("span")).color,
  }));
  expect(waitingLook.border).toBe("dashed");
  expect(waitingLook.color).not.toBe(waitingLook.name);
  await expect(pop.locator(".pop-person").nth(3)).toContainText("(вы, необязательно)");
  await expect(pop.locator(".pop-link a").first()).toHaveAttribute("href", "https://telemost.360.yandex.ru/j/0319350436");
  await expect(pop.locator(".pop-me-line")).toContainText("принято");
  // Текущий ответ — отметка состояния, не кнопка призыва: с галочкой, зелёная и без нажатия.
  const current = pop.locator(".pop-me-buttons button[aria-pressed='true']");
  await expect(current).toHaveText("✓ Принято");
  await expect(current).toBeDisabled();
  await expect(current).toHaveClass(/accepted/);
  await expect(pop.locator(".pop-me-buttons button", { hasText: "Отклонить" })).toBeEnabled();
  await expect(pop.locator(".pop-comment")).toHaveAttribute("placeholder", "Комментарий организатору");
  await expect(pop.locator(".cal-pop-btn", { hasText: "Удалить" })).toBeVisible();
  // Экземпляр повтора: «Удалить» не стирает молча, а спрашивает — только это
  // событие или всю серию; «Отмена» возвращает кнопки на место.
  await page.keyboard.press("Escape");
  await page.locator(".cal-ev.external", { hasText: "Ретро" }).first().click();
  const series = page.locator(".cal-pop.rich");
  await expect(series.locator(".cal-pop-title")).toHaveText("Ретро команды");
  await series.locator(".cal-pop-btn", { hasText: "Удалить" }).click();
  const ask = series.locator(".cal-pop-ask");
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Удалить только этот повтор");
  await expect(ask.getByRole("button", { name: "Только это событие" })).toBeVisible();
  await expect(ask.getByRole("button", { name: "Всю серию" })).toBeVisible();
  await ask.getByRole("button", { name: "Отмена" }).click();
  await expect(ask).toHaveCount(0);
  await expect(series.locator(".cal-pop-btn", { hasText: "Удалить" })).toBeVisible();

  // Приглашение без ответа видно прямо в сетке, не открывая плашку:
  // незакрашенное и пунктиром, как в Календаре macOS.
  await page.keyboard.press("Escape");
  const waitingEvent = page.locator(".cal-ev.external", { hasText: "Аналитика" });
  await expect(waitingEvent).toHaveClass(/unanswered/);
  expect(await waitingEvent.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("dashed");
  // На принятой встрече метки нет: она уже ваша.
  await expect(page.locator(".cal-ev.external", { hasText: "Монетизация" })).not.toHaveClass(/unanswered/);
  // В списке дня рядом с ней сказано словами, а не только цветом.
  await expect(page.locator(".cal-row", { hasText: "Аналитика" })).toContainText("без ответа");
});

// Удаление чужого события идёт в чужой календарь, а он отвечает не сразу:
// событие уходит с сетки сразу, запрос летит следом. Ошибка возвращает событие.
test("чужое событие уходит с сетки сразу, а удаление идёт в фоне", async ({ page, request }) => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database("/tmp/pagent-e2e.sqlite");
  const user = db.prepare("SELECT id FROM users WHERE email=?").get(E2E_EMAIL);
  db.prepare("DELETE FROM calendar_events").run();
  db.prepare("DELETE FROM calendar_accounts").run();
  db.prepare("INSERT INTO calendar_accounts(id,user_id,provider,preset,label,color,mode,server_url,username,credentials_enc,calendars_json,synced_at,created_at,auto_export) VALUES('acc1',?,'caldav','yandex','Яндекс','#3b82f6','full','https://caldav.yandex.ru','me@itfinance.tech','v1.x',?,datetime('now'),datetime('now'),'off')")
    .run(user.id, JSON.stringify([{ id: "c1", url: "https://caldav.yandex.ru/c1/", name: "Itfinance", color: "#3b82f6", selected: true, writable: true }]));
  const today = (await (await request.get("/api/day")).json()).date;
  const monday = shift(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const tuesday = shift(monday, 1);
  // Одиночное событие и два повтора одной серии: серия видна в сетке двумя
  // экземплярами, и уйти они должны вместе.
  const add = db.prepare("INSERT INTO calendar_events(id,account_id,calendar_id,uid,instance_key,series_uid,title,start_at,end_at,all_day,busy,etag,href,updated_at,repeat,sequence) VALUES(?,'acc1','c1',?,?,?,?,?,?,0,1,'\"e\"','https://calendar.yandex.ru/event?event_id=1',datetime('now'),?,1)");
  add.run("e1", "u1", null, null, "Разбор поставок", `${monday}T06:30:00.000Z`, `${monday}T07:30:00.000Z`, null);
  add.run("e2", "u2", `${monday}T08:30:00.000Z`, "u2", "Планёрка отдела", `${monday}T08:30:00.000Z`, `${monday}T09:00:00.000Z`, "Повторяется каждую неделю");
  add.run("e3", "u2", `${tuesday}T08:30:00.000Z`, "u2", "Планёрка отдела", `${tuesday}T08:30:00.000Z`, `${tuesday}T09:00:00.000Z`, "Повторяется каждую неделю");
  db.close();

  await page.goto("/#calendar");
  await page.evaluate(() => { localStorage.setItem("kizuna-calendar-mode", "week"); });
  await page.reload();
  const grid = page.locator("#calendar-view");
  const single = grid.locator(".cal-ev.external", { hasText: "Разбор поставок" });
  const series = grid.locator(".cal-ev.external", { hasText: "Планёрка отдела" });
  await expect(single).toHaveCount(1);
  await expect(series).toHaveCount(2);

  // Чужой календарь держит ответ: так видно, ждёт ли его окно.
  let releaseOk = () => {}, releaseFail = () => {};
  const held = new Promise((resolve) => { releaseOk = resolve; });
  const heldFail = new Promise((resolve) => { releaseFail = resolve; });
  let deletes = 0;
  await page.route("**/api/calendar/external/**", async (route) => {
    if (route.request().method() !== "DELETE") { await route.continue(); return; }
    deletes += 1;
    if (deletes === 1) {
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ removed: true, title: "Планёрка отдела", scope: "series" }) });
      return;
    }
    await heldFail;
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "remove_failed", message: "Календарь не ответил." } }) });
  });

  // «Всю серию»: оба повтора уходят с сетки, не дожидаясь чужого календаря.
  await series.first().click();
  const pop = page.locator(".cal-pop.rich");
  await pop.locator(".cal-pop-btn", { hasText: "Удалить" }).click();
  await pop.locator(".cal-pop-ask").getByRole("button", { name: "Всю серию" }).click();
  await expect(series).toHaveCount(0);
  await expect(pop).toHaveCount(0);
  await expect(page.locator("#toast")).not.toContainText("удалена");
  // CalDAV-сервера у прогона нет: строки убираем сами, как сделал бы провайдер.
  const after = new Database("/tmp/pagent-e2e.sqlite");
  after.prepare("DELETE FROM calendar_events WHERE uid='u2'").run();
  after.close();
  releaseOk();
  await expect(page.locator("#toast")).toContainText("Серия «Планёрка отдела» удалена из Яндекс");
  await expect(series).toHaveCount(0);

  // Отказ календаря: событие ушло сразу, но вернулось на место с объяснением.
  page.once("dialog", (dialog) => dialog.accept());
  await single.click();
  await page.locator(".cal-pop.rich .cal-pop-btn", { hasText: "Удалить" }).click();
  await expect(single).toHaveCount(0);
  releaseFail();
  await expect(page.locator("#toast")).toContainText("«Разбор поставок» не удалилось: Календарь не ответил.");
  await expect(single).toHaveCount(1);
});

// Своя серия: повторы разворачиваются в сетке, удаление из карточки убирает
// один повтор, правило меняется в карточке, на главной повтор виден в своём дне.
test("своя серия: повторы в сетке, «только этот повтор» из карточки, правило в карточке", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const today = (await (await request.get("/api/day")).json()).date;
  const monday = shift(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const created = await (await request.post("/api/captures", { data: { raw: "Стендап с командой", primaryType: "todo", due: { date: monday, time: "09:30", repeat: { freq: "daily" } } } })).json();
  await page.goto("/#calendar");
  await page.evaluate(() => { localStorage.setItem("kizuna-calendar-mode", "week"); });
  await page.reload();
  const calendar = page.locator("#calendar-view");
  const blocks = calendar.locator(".cal-ev.task", { hasText: "Стендап" });
  await expect(blocks).toHaveCount(7);
  await expect(blocks.first().locator(".cal-ev-repeat")).toHaveAttribute("title", "каждый день");
  // Из карточки, открытой на среду, «Удалить запись» предлагает выбор; «только
  // этот повтор» убирает среду, остальные дни остаются.
  const wednesday = shift(monday, 2);
  await calendar.locator(`.cal-col[data-date="${wednesday}"] .cal-ev.task`, { hasText: "Стендап" }).click();
  const dialog = page.locator("#review-dialog");
  await expect(dialog).toBeVisible();
  await page.locator("#review-dialog .card-delete").click();
  const ask = page.locator(".card-delete-ask");
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Только этот повтор" }).click();
  await expect(page.locator("#toast")).toContainText("убран");
  await expect(blocks).toHaveCount(6);
  await expect(calendar.locator(`.cal-col[data-date="${wednesday}"] .cal-ev.task`, { hasText: "Стендап" })).toHaveCount(0);
  const entry = (await (await request.get(`/api/captures/${created.entry.id}`)).json()).entry;
  expect(entry.interpretation.classification.entities.schedule.skip).toEqual([wednesday]);
  expect(entry.interpretation.classification.entities.schedule.repeat).toEqual({ freq: "daily", interval: 1, until: null });
  // В карточке правило видно и меняется: «не повторять» оставляет один блок.
  await calendar.locator(`.cal-col[data-date="${shift(monday, 3)}"] .cal-ev.task`, { hasText: "Стендап" }).click();
  await expect(dialog).toBeVisible();
  const propsBar = page.locator(".props-bar");
  if ((await propsBar.getAttribute("aria-expanded")) === "false") await propsBar.click();
  const repeat = page.locator("#review-repeat");
  await expect(repeat).toHaveValue("daily:1");
  await expect(page.locator("#review-repeat-until")).toBeVisible();
  await repeat.selectOption("");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#toast")).toContainText("Уточнение сохранено");
  await expect(blocks).toHaveCount(1);
  await expect(calendar.locator(`.cal-col[data-date="${monday}"] .cal-ev.task`, { hasText: "Стендап" })).toHaveCount(1);
});

// «Сегодня» на главной: повтор виден в своём часе с подписью правила. Время
// фиксировано на 13:00, чтобы строка «сейчас» стояла после утреннего повтора.
test("«Сегодня»: повторяющееся дело видно в своём часе с подписью повтора", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const today = (await (await request.get("/api/day")).json()).date;
  await request.post("/api/captures", { data: { raw: "Проверить почту", primaryType: "todo", due: { date: shift(today, -3), time: "09:00", repeat: { freq: "daily" } } } });
  const at = new Date(); at.setHours(13, 0, 0, 0);
  await page.clock.install({ time: at });
  await page.goto("/#today");
  const todo = page.locator("#todo");
  const card = todo.locator(".entry", { hasText: "Проверить почту" });
  await expect(card).toBeVisible();
  // Дело стоит в своём часе, и час назван колонкой времени слева — в строке
  // остаётся то, чего колонка не говорит: что дело повторяется.
  await expect(card.locator(".tag.due")).toHaveText("каждый день");
  await expect(todo.locator(".day-row", { hasText: "Проверить почту" }).locator(".day-time")).toHaveText("09:00");
  await expect(card.locator(".tag.late")).toHaveCount(0);
});
// Сетка по умолчанию дотягивается до низа окна, а её нижний край тянется
// рукой: высота переживает перезагрузку, двойной клик возвращает подгонку.
test("сетка календаря встаёт по высоте окна и тянется за нижний край", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#calendar");
  await page.evaluate(() => { localStorage.setItem("kizuna-calendar-mode", "week"); });
  await page.reload();
  const scroll = page.locator("#calendar-view .cal-scroll");
  await expect(scroll).toBeVisible();
  const height = () => scroll.evaluate((element) => Math.round(element.getBoundingClientRect().height));
  // Высота в пикселях округляется по-разному в сетке и в окне — допуск в пиксель.
  const off = (target) => async () => Math.abs((await height()) - target);
  const pageOverflow = () => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  // Страница встаёт в окно целиком: сетка забрала всё место, но окно не
  // прокручивается и пустоты под календарём нет.
  await expect.poll(pageOverflow).toBeLessThanOrEqual(1);
  const fitted = await height();
  expect(fitted).toBeGreaterThan(240);
  await page.setViewportSize({ width: 1440, height: 860 });
  await expect.poll(off(fitted - 40)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(off(fitted)).toBeLessThanOrEqual(1);

  // Край тянут вверх на 50px — сетка ниже и такой остаётся после перезагрузки.
  const box = await scroll.boundingBox();
  const x = box.x + box.width / 2, edge = box.y + box.height - 1;
  await page.mouse.move(x, edge);
  await page.mouse.down();
  await page.mouse.move(x, edge - 50, { steps: 5 });
  await page.mouse.up();
  await expect.poll(off(fitted - 50)).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(scroll).toBeVisible();
  await expect.poll(off(fitted - 50)).toBeLessThanOrEqual(1);

  // Двойной клик по краю — снова по окну.
  const again = await scroll.boundingBox();
  await page.mouse.dblclick(again.x + again.width / 2, again.y + again.height - 1);
  await expect.poll(off(fitted)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => localStorage.getItem("kizuna-calendar-height"))).toBeNull();
});

// Дело со временем закрывается кружком прямо в блоке сетки — как дело «без
// времени», и промах снимается «Вернуть».
test("дело со временем закрывается кружком в сетке календаря", async ({ page, request }) => {
  await request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
  const today = (await (await request.get("/api/day")).json()).date;
  const created = await (await request.post("/api/captures", { data: { raw: "Проверить доступ голосового агента", primaryType: "todo", due: { date: today, time: "11:00" } } })).json();
  await page.goto("/#calendar");
  await page.evaluate(() => { localStorage.setItem("kizuna-calendar-mode", "week"); });
  await page.reload();
  const block = page.locator("#calendar-view .cal-ev.task", { hasText: "голосового агента" });
  await expect(block).toBeVisible();
  await block.locator(".cal-box").click();
  await expect(page.locator("#toast")).toContainText("Готово: «Проверить доступ голосового");
  await expect(page.locator("#calendar-view .cal-ev.task.done", { hasText: "голосового агента" })).toBeVisible();
  await expect(page.locator("#review-dialog")).toBeHidden();
  await page.locator("#toast").getByRole("button", { name: "Вернуть" }).click();
  await expect(page.locator("#calendar-view .cal-ev.task:not(.done)", { hasText: "голосового агента" })).toBeVisible();
  await request.delete(`/api/captures/${created.entry.id}`);
});
