import { test, expect } from "@playwright/test";
import { E2E_DB } from "./fixtures/e2e-env.js";

// Пилюля метрики дня: запланировано · сделано · осталось · просрочено, серия и
// искра за неделю. Она стоит на «Сегодня» над полем и в заголовке «Доски» и
// считает из тех же списков, что вкладки «День» и «Закрыто» и бейджи дока.
const reset = (request) => request.post("/api/reset", { data: { confirmation: "СБРОСИТЬ КИЗУНА" } });
// Обложка «Сегодня» живёт по часам: чтобы прогон не зависел от времени суток,
// страница видит один и тот же день — 13:00. Таймеры при этом идут как обычно.
const dayAt = (hour) => { const at = new Date(); at.setHours(hour, 0, 0, 0); return at; };
// Дни считаются в часовом поясе приложения, а не в UTC.
const day = (shift) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + shift * 86400000));
const deed = async (request, raw, due) => {
  const created = await (await request.post("/api/captures", { data: { raw, primaryType: "todo", due: { date: due } } })).json();
  return created.entry.id;
};
const closeDeed = async (request, id) => {
  const entry = (await (await request.get(`/api/captures/${id}`)).json()).entry;
  for (const projection of entry.projections.filter((item) => item.type === "task")) await request.post(`/api/projections/${projection.id}/complete`, { data: {} });
};
// Закрытие задним числом: журнал событий только дописывается, поэтому событие
// «закрыто» со своим днём вставляется в базу прогона готовым, как календарь в calendar.spec.js.
const closeDeedOn = async (request, id, date, hour = 9) => {
  const entry = (await (await request.get(`/api/captures/${id}`)).json()).entry;
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(E2E_DB);
  const at = `${date}T${String(hour).padStart(2, "0")}:15:00.000Z`;
  for (const projection of entry.projections.filter((item) => item.type === "task"))
    db.prepare("INSERT INTO ledger_events(id,event_type,capture_id,projection_id,interpretation_id,actor,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(`hist-${Math.random().toString(16).slice(2)}`, "completed", id, projection.id, projection.interpretation_id ?? null, "user", at, at);
  db.close();
};
const pill = (page) => page.locator("#day-metric");
const number = (page, kind) => pill(page).locator(`.metric-pill [data-mc="${kind}"] .mc-n`);
// Ящик открывается вкладкой; уже открытый вторым щелчком не закрывается.
async function openTab(page, name) {
  const tab = page.getByRole("tab", { name });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}
// Нажатие на сегмент. Пока панель раскрыта, она закрывает пилюлю собой, а её карточки стоят
// не там, где сегменты, — под курсором в точке сегмента может оказаться чужая карточка.
// Поэтому нажатие кладётся прямо на сегмент; настоящее нажатие карточки панели проверено отдельно.
const press = (page, kind) => pill(page).locator(`.metric-pill [data-mc="${kind}"]`).dispatchEvent("click");
// Как виден элемент глазами: прозрачность своя, умноженная на прозрачность предков.
const shown = (locator) => locator.evaluate((element) => { let opacity = 1; for (let at = element; at && at.nodeType === 1; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity); return opacity; });

test.beforeEach(async ({ page, request }) => {
  await reset(request);
  await page.clock.install({ time: dayAt(13) });
});

test("числа сходятся: пилюля, вкладки «День» и «Закрыто» и бейджи дока говорят одно и то же", async ({ page, request }) => {
  const done = await deed(request, "Подготовить договор для подрядчика", day(0));
  await deed(request, "Позвонить в бухгалтерию", day(0));
  await deed(request, "Заказать воду в офис", day(0));
  await deed(request, "Отправить счёт клиенту", day(-1));
  await closeDeed(request, done);
  await page.goto("/#today");

  // запланировано · сделано · осталось · просрочено = 4 · 1 · 3 · 1
  await expect(number(page, "planned")).toHaveText("4");
  await expect(number(page, "done")).toHaveText("1");
  await expect(number(page, "left")).toHaveText("3");
  await expect(number(page, "late")).toHaveText("1");
  await expect(pill(page).locator('.metric-pill [data-mc="done"]')).toHaveAttribute("aria-label", "сделано 1 из 4");
  await expect(pill(page).locator('.metric-pill [data-mc="late"]')).toHaveAttribute("aria-label", "просрочено 1");
  await expect(pill(page).locator('.metric-pill [data-mc="left"]')).toHaveAttribute("aria-label", "осталось 3");
  await expect(pill(page).locator('.metric-pill [data-mc="planned"]')).toHaveAttribute("aria-label", "запланировано 4");
  // Группа называется по-человечески, а полоска под пилюлей заполнена на четверть.
  await expect(pill(page).locator(".metric-pill")).toHaveAttribute("role", "group");
  await expect(pill(page).locator(".metric-pill")).toHaveAttribute("aria-label", "Метрика дня");
  const fill = pill(page).locator(".metric-wrap > .metric-strip > i");
  await expect(fill).toHaveAttribute("style", /width: 25(\.0)?%/);
  // Заливка дорастает плавно: ждём, пока нарисованная ширина дойдёт до четверти дорожки.
  await expect
    .poll(async () => { const [bar, track] = await Promise.all([fill.boundingBox(), pill(page).locator(".metric-wrap > .metric-strip").boundingBox()]); return bar.width / track.width; })
    .toBeCloseTo(0.25, 1);

  // Те же числа — у вкладок и бейджей дока: сделано = «Закрыто N», просрочено = «M просрочено»,
  // открытое на сегодня = «N дел», а в сумме с просрочкой и сделанным получается запланировано.
  const dayTab = await page.locator("#tab-day .drawer-count").innerText();
  const open = Number(dayTab.match(/(\d+) дел/)[1]);
  const late = Number(dayTab.match(/(\d+) просрочено/)?.[1] ?? 0);
  const closed = Number(await page.locator("#tab-journal b").innerText());
  expect([open, late, closed]).toEqual([2, 1, 1]);
  expect(Number(await number(page, "done").innerText())).toBe(closed);
  expect(Number(await number(page, "late").innerText())).toBe(late);
  expect(Number(await number(page, "left").innerText())).toBe(open + late);
  expect(Number(await number(page, "planned").innerText())).toBe(open + late + closed);
  await expect(page.locator("#dock-badge-done")).toHaveText(String(closed));
  await expect(page.locator("#dock-badge-today")).toHaveText(String(open));

  // У свёрнутой пилюли подсказка — полная фраза и что сделает нажатие.
  await expect(pill(page).locator('.metric-pill [data-mc="late"]')).toHaveAttribute("title", "Просрочено: 1 · нажмите — только просроченные");
  await expect(pill(page).locator('.metric-pill [data-mc="done"]')).toHaveAttribute("title", "Сделано 1 из 4 · нажмите — вкладка «Закрыто»");
});

test("серия и неделя: история из /api/done?only=byDay, сегодняшняя точка живая", async ({ page, request }) => {
  // вчера и позавчера закрыто по делу, три дня назад — пусто, шесть дней назад — одно: неделя = 2 + 1 + сегодня
  await closeDeedOn(request, await deed(request, "Закрытое вчера", day(-1)), day(-1));
  await closeDeedOn(request, await deed(request, "Закрытое позавчера", day(-2)), day(-2));
  await closeDeedOn(request, await deed(request, "Закрытое давно", day(-6)), day(-6));
  await deed(request, "Закрою сегодня", day(0));
  await page.goto("/#today");
  // сегодня ещё ничего не закрыто: серия считается от вчера и не обрывается — два дня
  await expect(number(page, "streak")).toHaveText("2");
  await expect(pill(page).locator('.metric-pill [data-mc="streak"]')).toHaveAttribute("aria-label", "серия 2 дня");
  await expect(pill(page).locator('.metric-pill [data-mc="week"]')).toHaveAttribute("aria-label", "за неделю 3 дела");
  await expect(pill(page).locator('.metric-pill [data-mc="week"] .metric-spark circle')).toHaveCount(1);
  // закрыли дело сегодня — серия и неделя растут сразу
  await page.locator("#todo .entry").filter({ hasText: "Закрою сегодня" }).locator(".completion-button").click();
  await expect(number(page, "streak")).toHaveText("3");
  await expect(pill(page).locator('.metric-pill [data-mc="week"]')).toHaveAttribute("aria-label", "за неделю 4 дела");
  // в раскрытой панели у «за неделю» то же число, а у серии — подпись «серия»
  await pill(page).locator(".metric-pill").hover();
  await expect(pill(page).locator(".metric-dock")).toHaveClass(/open/);
  await expect(pill(page).locator('.metric-panel [data-pc="week"] .mc-n')).toHaveText("4");
  await expect(pill(page).locator('.metric-panel [data-pc="streak"] .mc-l')).toHaveText("серия");
});

test("наведение подсвечивает то, что счётчик считает, а нажатие оставляет в списке только это", async ({ page, request }) => {
  await deed(request, "Подготовить договор для подрядчика", day(0));
  await deed(request, "Позвонить в бухгалтерию", day(0));
  await deed(request, "Отправить счёт клиенту", day(-1));
  await page.goto("/#today");
  await openTab(page, /^День/);
  await expect(number(page, "late")).toHaveText("1");

  // Наведение на «просрочено»: подсвечены полка «просрочено» и её строка, остальное не тронуто.
  const late = pill(page).locator('.metric-pill [data-mc="late"]');
  await late.hover();
  await expect(page.locator("#todo .day-group.late")).toHaveClass(/metric-hl/);
  await expect(page.locator("#todo .day-late .entry")).toHaveClass(/metric-hl/);
  await expect(page.locator("#todo .day-group.today")).not.toHaveClass(/metric-hl/);
  await expect(page.locator("#tab-journal")).not.toHaveClass(/metric-hl/);
  // Ушёл курсор — подсветка гаснет.
  await page.mouse.move(2, 2);
  await expect(page.locator("#todo .metric-hl")).toHaveCount(0);
  // «Осталось» подсвечивает полки дня, «сделано» — вкладку «Закрыто».
  await pill(page).locator('.metric-pill [data-mc="left"]').hover();
  await expect(page.locator("#todo .day-group.today")).toHaveClass(/metric-hl/);
  await expect(page.locator("#todo .day-rows .entry").first()).toHaveClass(/metric-hl/);
  await expect(page.locator("#todo .day-group.late")).not.toHaveClass(/metric-hl/);
  await page.mouse.move(2, 2);
  await pill(page).locator('.metric-pill [data-mc="done"]').hover();
  await expect(page.locator("#tab-journal")).toHaveClass(/metric-hl/);
  await page.mouse.move(2, 2);
  await expect(page.locator(".metric-hl")).toHaveCount(0);

  // Нажатие: в списке остаётся просроченное, остальное приглушено, над списком — строка со «Сбросить».
  await late.hover();
  await press(page, "late");
  await expect(page.locator("#todo")).toHaveAttribute("data-metric-filter", "late");
  await expect(page.locator(".metric-fnote")).toHaveText("Только просроченные · 1Сбросить");
  await expect(pill(page).locator('.metric-pill [data-mc="late"]')).toHaveAttribute("aria-pressed", "true");
  expect(await shown(page.locator("#todo .day-rows .entry").first())).toBeLessThan(0.5);
  expect(await shown(page.locator("#todo .day-group.today"))).toBeLessThan(0.5);
  expect(await shown(page.locator("#todo .day-late .entry"))).toBe(1);
  expect(await shown(page.locator("#todo .day-group.late"))).toBe(1);
  // Повторное нажатие снимает фильтр, и «Сбросить» — тоже.
  await press(page, "late");
  await expect(page.locator("#todo")).not.toHaveAttribute("data-metric-filter", /.+/);
  await expect(page.locator(".metric-fnote")).toHaveCount(0);
  await press(page, "left");
  await expect(page.locator("#todo")).toHaveAttribute("data-metric-filter", "open");
  await expect(page.locator(".metric-fnote")).toHaveText("Только открытые · 3Сбросить");
  await page.locator(".metric-fnote-reset").click();
  await expect(page.locator("#todo")).not.toHaveAttribute("data-metric-filter", /.+/);
  await expect(pill(page).locator('.metric-pill [data-mc="left"]')).toBeFocused();
  // Фильтр не переживает переключение вкладки.
  await press(page, "late");
  await expect(page.locator("#todo")).toHaveAttribute("data-metric-filter", "late");
  await page.getByRole("tab", { name: /^Закрыто/ }).click();
  await page.getByRole("tab", { name: /^День/ }).click();
  await expect(page.locator("#todo")).not.toHaveAttribute("data-metric-filter", /.+/);
  await expect(page.locator(".metric-fnote")).toHaveCount(0);

  // «Сделано» открывает вкладку «Закрыто».
  await press(page, "done");
  await expect(page.getByRole("tab", { name: /^Закрыто/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#journal")).toBeVisible();
  // «Запланировано» возвращает «День» и коротко подсвечивает полки.
  await press(page, "planned");
  await expect(page.getByRole("tab", { name: /^День/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#todo .metric-flash").first()).toBeVisible();
});

test("слова сводки подчёркиваются по наведению на счётчик", async ({ page, request }) => {
  await deed(request, "Позвонить в бухгалтерию", day(0));
  await deed(request, "Отправить счёт клиенту", day(-1));
  await page.goto("/#today");
  // Сводка видна, пока все ящики закрыты: повторный щелчок по открытой вкладке закрывает ящик.
  const dayTab = page.getByRole("tab", { name: /^День/ });
  if ((await dayTab.getAttribute("aria-selected")) === "true") await dayTab.click();
  await expect(page.locator("#today-brief")).toBeVisible();
  await expect(page.locator('#today-brief [data-w="late"]')).toHaveText("1 дело просрочено");
  await expect(page.locator('#today-brief [data-w="open"]')).toHaveText("на сегодня");
  await pill(page).locator('.metric-pill [data-mc="late"]').hover();
  await expect(page.locator('#today-brief [data-w="late"]')).toHaveClass(/metric-hl/);
  await expect(page.locator('#today-brief [data-w="late"]')).toHaveCSS("text-decoration-line", "underline");
  await expect(page.locator('#today-brief [data-w="open"]')).not.toHaveClass(/metric-hl/);
  await page.mouse.move(2, 2);
  await pill(page).locator('.metric-pill [data-mc="left"]').hover();
  await expect(page.locator('#today-brief [data-w="open"]')).toHaveClass(/metric-hl/);
  // Слова — обёртка: текст сводки тот же.
  await expect(page.locator("#today-brief")).toContainText("1 дело просрочено, на сегодня —");
});

test("панель подписей — слой поверх: соседние блоки не сдвигаются ни на пиксель", async ({ page, request }) => {
  await deed(request, "Подготовить договор для подрядчика", day(0));
  await deed(request, "Отправить счёт клиенту", day(-1));
  await page.goto("/#today");
  await expect(number(page, "planned")).toHaveText("2");
  const boxes = async () => ({
    form: await page.locator("#capture-form").boundingBox(),
    tabs: await page.locator("#today-tabs").boundingBox(),
    list: await page.locator("#todo").boundingBox(),
    pill: await pill(page).locator(".metric-pill").boundingBox(),
    strip: await pill(page).locator(".metric-wrap > .metric-strip").boundingBox(),
  });
  const before = await boxes();
  const dock = pill(page).locator(".metric-dock");
  const panel = pill(page).locator(".metric-panel");
  await expect(panel).toBeHidden();
  await pill(page).locator(".metric-pill").hover();
  await expect(dock).toHaveClass(/open/);
  await expect(panel).toBeVisible();
  // Те же шесть значений с подписями.
  await expect(panel.locator(".mc-l")).toHaveText(["запланировано", "сделано", "осталось", "просрочено", "серия", "за неделю"]);
  await expect(panel).toHaveAttribute("role", "group");
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  // Панель встала поверх пилюли: верх общий, внутри окна, горизонтальной прокрутки нет.
  const open = await panel.boundingBox();
  expect(open.y).toBeCloseTo(before.pill.y, 0);
  expect(open.x).toBeGreaterThanOrEqual(0);
  expect(open.x + open.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  // Появление — прозрачность и масштаб: дождёмся, пока панель станет видимой целиком.
  await expect.poll(() => panel.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1);
  // Подсказок у раскрытой панели нет.
  await expect(pill(page).locator('.metric-pill [data-mc="late"]')).not.toHaveAttribute("title", /.+/);
  // Вёрстка не шелохнулась: ни поле, ни вкладки, ни список, ни сама пилюля.
  expect(await boxes()).toEqual(before);
  // Escape закрывает панель, подсказки возвращаются, вёрстка снова та же.
  await page.keyboard.press("Escape");
  await expect(dock).not.toHaveClass(/open/);
  await expect(panel).toBeHidden();
  await expect(panel).toHaveAttribute("aria-hidden", "true");
  await expect(pill(page).locator('.metric-pill [data-mc="late"]')).toHaveAttribute("title", /^Просрочено: 1/);
  expect(await boxes()).toEqual(before);
  // Уход курсора закрывает панель сам. После Escape она открывается снова, только когда курсор ушёл и вернулся.
  await page.mouse.move(2, 2);
  await pill(page).locator(".metric-pill").hover();
  await expect(dock).toHaveClass(/open/);
  await page.mouse.move(2, 2);
  await expect(dock).not.toHaveClass(/open/);
  // Карточка раскрытой панели нажимается так же, как сегмент под ней.
  await page.mouse.move(2, 2);
  await pill(page).locator(".metric-pill").hover();
  await expect(dock).toHaveClass(/open/);
  await panel.locator('[data-pc="late"]').click();
  await expect(page.locator("#todo")).toHaveAttribute("data-metric-filter", "late");
  await expect(pill(page).locator('.metric-panel [data-pc="late"]')).toHaveAttribute("aria-pressed", "true");
  await panel.locator('[data-pc="late"]').click();
  await expect(page.locator("#todo")).not.toHaveAttribute("data-metric-filter", /.+/);
  await page.mouse.move(2, 2);
  await expect(dock).not.toHaveClass(/open/);
  // Шеврон раскрывает и сворачивает.
  await pill(page).locator(".mc-tog").click();
  await expect(dock).toHaveClass(/open/);
  await expect(pill(page).locator(".mc-tog")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#capture-form").click();
  await expect(dock).not.toHaveClass(/open/);
  await expect(pill(page).locator(".mc-tog")).toHaveAttribute("aria-expanded", "false");
});

test("с клавиатуры: фокус на сегменте раскрывает панель с кольцом на такой же карточке", async ({ page, request }) => {
  await deed(request, "Подготовить договор для подрядчика", day(0));
  await deed(request, "Отправить счёт клиенту", day(-1));
  await page.goto("/#today");
  await expect(number(page, "planned")).toHaveText("2");
  const dock = pill(page).locator(".metric-dock");
  // Табуляцией с начала страницы доходим до первого сегмента: пилюля стоит в порядке табуляции перед полем записи.
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => Boolean(document.activeElement?.dataset?.mc))) break;
  }
  await expect(pill(page).locator('.metric-pill [data-mc="planned"]')).toBeFocused();
  await expect(dock).toHaveClass(/open/);
  // Фокус стоит на сегменте под панелью, поэтому кольцо рисуется на такой же карточке панели.
  await expect(pill(page).locator('.metric-panel [data-pc="planned"]')).toHaveClass(/kf/);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(pill(page).locator('.metric-pill [data-mc="late"]')).toBeFocused();
  await expect(pill(page).locator('.metric-panel [data-pc="late"]')).toHaveClass(/kf/);
  await expect(pill(page).locator('.metric-panel [data-pc="planned"]')).not.toHaveClass(/kf/);
  // Фокус с клавиатуры подсвечивает то же, что наведение мыши.
  await expect(page.locator("#todo .day-group.late")).toHaveClass(/metric-hl/);
  // Enter нажимает сегмент: в списке остаётся просроченное.
  await page.keyboard.press("Enter");
  await expect(page.locator("#todo")).toHaveAttribute("data-metric-filter", "late");
  // Сегмент остался тем же и в фокусе: пилюлю никто не пересоздавал.
  await expect(pill(page).locator('.metric-pill [data-mc="late"]')).toBeFocused();
  await expect(pill(page).locator('.metric-pill [data-mc="late"]')).toHaveAttribute("aria-pressed", "true");
  // Escape сворачивает панель, фокус остаётся на сегменте.
  await page.keyboard.press("Escape");
  await expect(dock).not.toHaveClass(/open/);
  await expect(pill(page).locator('.metric-pill [data-mc="late"]')).toBeFocused();
});

test("кружок в списке обновляет числа на месте: сделано растёт, осталось убывает, фокус не теряется", async ({ page, request }) => {
  await deed(request, "Подготовить договор для подрядчика", day(0));
  await deed(request, "Позвонить в бухгалтерию", day(0));
  const third = await deed(request, "Заказать воду в офис", day(0));
  await page.goto("/#today");
  await openTab(page, /^День/);
  await expect(number(page, "planned")).toHaveText("3");
  await expect(number(page, "done")).toHaveText("0");
  await expect(number(page, "left")).toHaveText("3");
  // Метка на самой пилюле: если её пересоздадут, метка пропадёт.
  await pill(page).locator(".metric-pill").evaluate((element) => { element.dataset.kept = "yes"; });

  await page.locator("#todo .entry").filter({ hasText: "Подготовить договор" }).locator(".completion-button").click();
  await expect(number(page, "done")).toHaveText("1", { timeout: 5000 });
  await expect(number(page, "left")).toHaveText("2");
  await expect(number(page, "planned")).toHaveText("3");
  await expect(page.locator("#tab-journal b")).toHaveText("1");
  await expect(pill(page).locator('.metric-pill [data-mc="done"]')).toHaveAttribute("aria-label", "сделано 1 из 3");
  // Пилюля не пересоздавалась.
  await expect(pill(page).locator(".metric-pill")).toHaveAttribute("data-kept", "yes");
  await expect(pill(page).locator(".metric-wrap > .metric-strip > i")).toHaveAttribute("style", /width: 33\.3%/);

  // Число «сделано» коротко подпрыгивает, а фокус на сегменте остаётся: дело закрывают из другого места (по потоку журнала страница перечитывает себя сама).
  const segment = pill(page).locator('.metric-pill [data-mc="late"]');
  await segment.focus();
  await closeDeed(request, third);
  await expect(number(page, "done")).toHaveText("2", { timeout: 8000 });
  await expect(number(page, "left")).toHaveText("1");
  await expect(segment).toBeFocused();
  await expect(pill(page).locator(".metric-pill")).toHaveAttribute("data-kept", "yes");
  // Возврат в работу из «Закрыто» тоже считается сразу.
  await page.getByRole("tab", { name: /^Закрыто/ }).click();
  await page.locator("#journal .entry").first().locator(".completion-button").click();
  await expect(number(page, "done")).toHaveText("1", { timeout: 5000 });
  await expect(number(page, "left")).toHaveText("2");
});

const board = (page) => page.locator("#board-metric");
const boardNumber = (page, kind) => board(page).locator(`.metric-pill [data-mc="${kind}"] .mc-n`);
const boardPress = (page, kind) => board(page).locator(`.metric-pill [data-mc="${kind}"]`).dispatchEvent("click");

test("доска: пилюля у правого края заголовка с теми же числами, «просрочено» оставляет только просроченные карточки", async ({ page, request }) => {
  const done = await deed(request, "Подготовить договор для подрядчика", day(0));
  await deed(request, "Позвонить в бухгалтерию", day(0));
  await deed(request, "Заказать воду в офис", day(0));
  await deed(request, "Отправить счёт клиенту", day(-1));
  await closeDeed(request, done);
  // Вход сразу на «Доску»: загрузка журнала не должна падать, пилюля считает по нему.
  await page.goto("/#board");
  await expect(board(page).locator(".metric-pill")).toBeVisible();
  // Тост «Не удалось загрузить данные» держится секунды, поэтому, если первая загрузка упала, он ещё на экране.
  expect(await page.locator("#toast").innerText()).not.toContain("Не удалось загрузить");
  await expect(boardNumber(page, "planned")).toHaveText("4");
  await expect(boardNumber(page, "done")).toHaveText("1");
  await expect(boardNumber(page, "left")).toHaveText("3");
  await expect(boardNumber(page, "late")).toHaveText("1");
  await expect(board(page).locator('.metric-pill [data-mc="done"]')).toHaveAttribute("aria-label", "сделано 1 из 4");
  await expect(board(page).locator(".metric-pill")).toHaveAttribute("aria-label", "Метрика дня");
  // Место: в строке заголовка «Доска», у правого края, по вертикали по центру заголовка.
  await expect(page.locator(".board-page .page-heading #board-metric")).toHaveCount(1);
  const heading = await page.locator(".board-page h2").boundingBox();
  const at = await board(page).locator(".metric-pill").boundingBox();
  expect(at.x).toBeGreaterThan(heading.x + heading.width);
  expect(Math.abs(at.y + at.height / 2 - (heading.y + heading.height / 2))).toBeLessThan(3);
  const controls = await page.locator("#board .board-controls").boundingBox();
  expect(Math.abs(at.x + at.width - (controls.x + controls.width))).toBeLessThan(6);
  // Полоска висит под пилюлей и высоту строки заголовка не меняет.
  const strip = await board(page).locator(".metric-wrap > .metric-strip").boundingBox();
  expect(strip.y).toBeGreaterThanOrEqual(at.y + at.height);
  await expect(board(page).locator(".metric-wrap > .metric-strip > i")).toHaveAttribute("style", /width: 25(\.0)?%/);

  // Наведение на «просрочено» подсвечивает просроченную карточку, на «сделано» — колонку «Закрыто».
  const lateCard = page.locator(".board-card.is-late");
  await expect(lateCard).toHaveCount(1);
  await expect(lateCard).toContainText("Отправить счёт");
  await board(page).locator('.metric-pill [data-mc="late"]').hover();
  await expect(lateCard).toHaveClass(/metric-hl/);
  await expect(page.locator(".board-card:not(.is-late)").first()).not.toHaveClass(/metric-hl/);
  await page.mouse.move(2, 2);
  await board(page).locator('.metric-pill [data-mc="done"]').hover();
  await expect(page.locator(".board-done-column")).toHaveClass(/metric-hl/);
  await page.mouse.move(2, 2);
  await board(page).locator('.metric-pill [data-mc="left"]').hover();
  await expect(page.locator(".board-column:not(.board-done-column):not(.ghost)").first()).toHaveClass(/metric-hl/);
  await expect(page.locator(".board-done-column")).not.toHaveClass(/metric-hl/);
  await page.mouse.move(2, 2);
  await expect(page.locator(".metric-hl")).toHaveCount(0);

  // Нажатие: просроченная карточка видна целиком, остальные и «Закрыто» приглушены; повторное нажатие снимает.
  await boardPress(page, "late");
  await expect(page.locator("#board-columns")).toHaveAttribute("data-metric-filter", "late");
  await expect(board(page).locator('.metric-pill [data-mc="late"]')).toHaveAttribute("aria-pressed", "true");
  expect(await shown(lateCard)).toBe(1);
  expect(await shown(page.locator(".board-column:not(.board-done-column) .board-card:not(.is-late)").first())).toBeLessThan(0.5);
  expect(await shown(page.locator(".board-done-column"))).toBeLessThan(0.5);
  await boardPress(page, "late");
  await expect(page.locator("#board-columns")).not.toHaveAttribute("data-metric-filter", /.+/);
  expect(await shown(page.locator(".board-card:not(.is-late)").first())).toBe(1);
  expect(await shown(page.locator(".board-done-column"))).toBe(1);
  // «Сделано» — подсветка колонки «Закрыто», остальные колонки приглушены.
  await boardPress(page, "done");
  await expect(page.locator("#board-columns")).toHaveAttribute("data-metric-filter", "done");
  expect(await shown(page.locator(".board-done-column"))).toBe(1);
  expect(await shown(page.locator(".board-column:not(.board-done-column):not(.ghost)").first())).toBeLessThan(0.5);
  await boardPress(page, "done");
  await expect(page.locator("#board-columns")).not.toHaveAttribute("data-metric-filter", /.+/);
  // Фильтр не переживает перестановку панели доски: смена группировки снимает его.
  await boardPress(page, "late");
  await expect(page.locator("#board-columns")).toHaveAttribute("data-metric-filter", "late");
  await page.locator('#board-view [data-view="list"]').click();
  await expect(page.locator("#board-columns")).not.toHaveAttribute("data-metric-filter", /.+/);
  await expect(board(page).locator('.metric-pill [data-mc="late"]')).toHaveAttribute("aria-pressed", "false");

  // В виде «Список» те же строки: просроченная помечена, остальные при фильтре приглушены.
  await expect(page.locator("#board-flat .board-row.is-late")).toHaveCount(1);
  await boardPress(page, "late");
  await expect(page.locator("#board-flat")).toHaveAttribute("data-metric-filter", "late");
  expect(await shown(page.locator("#board-flat .board-row.is-late"))).toBe(1);
  expect(await shown(page.locator("#board-flat .g-kids:not(.done) .board-row:not(.is-late)").first())).toBeLessThan(0.5);
  expect(await shown(page.locator("#board-flat .g-kids.done"))).toBeLessThan(0.5);
  await boardPress(page, "late");
  await page.locator('#board-view [data-view="board"]').click();

  // Фильтр не переживает уход со страницы, а числа на «Сегодня» те же.
  await boardPress(page, "late");
  await page.goto("/#today");
  await page.goto("/#board");
  await expect(page.locator("#board-columns")).not.toHaveAttribute("data-metric-filter", /.+/);
  await expect(board(page).locator('.metric-pill [data-mc="late"]')).toHaveAttribute("aria-pressed", "false");
  await page.goto("/#today");
  await expect(page.locator("#day-metric .metric-pill")).toBeVisible();
  for (const [kind, value] of [["planned", "4"], ["done", "1"], ["left", "3"], ["late", "1"]]) await expect(number(page, kind)).toHaveText(value);
});

test("доска: кружок на карточке обновляет числа пилюли, а возврат из «Закрыто» возвращает их", async ({ page, request }) => {
  await deed(request, "Подготовить договор для подрядчика", day(0));
  await deed(request, "Отправить счёт клиенту", day(-1));
  await page.goto("/#board");
  await expect(boardNumber(page, "planned")).toHaveText("2");
  await expect(boardNumber(page, "late")).toHaveText("1");
  await page.locator(".board-card.is-late .board-done").click();
  // Просроченное закрыто: просрочек нет, сделано 1, а сегмент «просрочено» приглушён.
  await expect(boardNumber(page, "late")).toHaveText("0", { timeout: 5000 });
  await expect(boardNumber(page, "done")).toHaveText("1");
  await expect(boardNumber(page, "left")).toHaveText("1");
  await expect(boardNumber(page, "planned")).toHaveText("2");
  await expect(board(page).locator('.metric-pill [data-mc="late"]')).toHaveClass(/is-zero/);
  await expect(page.locator(".board-card.is-late")).toHaveCount(0);
  // Фильтр, которому больше нечего показывать, не включается.
  await boardPress(page, "late");
  await expect(page.locator("#board-columns")).not.toHaveAttribute("data-metric-filter", /.+/);
  // Возврат из «Закрыто» возвращает просрочку: карточка снова помечена.
  await page.locator(".board-done-column .board-card.closed", { hasText: "Отправить счёт" }).locator(".board-done").click();
  await expect(boardNumber(page, "late")).toHaveText("1", { timeout: 5000 });
  await expect(boardNumber(page, "done")).toHaveText("0");
  await expect(page.locator(".board-card.is-late")).toHaveCount(1);
});

// На телефоне наведения нет: пилюля занимает всю ширину, точек-разделителей нет,
// первое нажатие раскрывает подписи, а второе уже действует.
test.describe("телефон", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("пилюля на всю ширину; первое нажатие раскрывает подписи, второе включает фильтр", async ({ page, request }) => {
    await deed(request, "Подготовить договор для подрядчика", day(0));
    await deed(request, "Отправить счёт клиенту", day(-1));
    await page.goto("/#today");
    await expect(number(page, "planned")).toHaveText("2");
    const wrap = await pill(page).locator(".metric-wrap").boundingBox();
    const box = await page.locator("#capture-form").boundingBox();
    // На всю ширину колонки: как поле записи под ней.
    expect(Math.abs(wrap.width - box.width)).toBeLessThan(2);
    await expect(pill(page).locator(".mc-sep").first()).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const pillBox = await pill(page).locator(".metric-pill").boundingBox();
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(390);

    const dock = pill(page).locator(".metric-dock");
    const late = pill(page).locator('.metric-pill [data-mc="late"]');
    await late.tap();
    await expect(dock).toHaveClass(/open/);
    await expect(page.locator("#todo")).not.toHaveAttribute("data-metric-filter", /.+/);
    // Панель — сетка карточек в ширину окна, за края не выходит.
    const panel = await pill(page).locator(".metric-panel").boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    await pill(page).locator('.metric-panel [data-pc="late"]').tap();
    await expect(page.locator("#todo")).toHaveAttribute("data-metric-filter", "late");
    // Нажатие мимо закрывает панель.
    await page.locator("#today-tabs").tap();
    await expect(dock).not.toHaveClass(/open/);
  });

  test("доска: пилюля своей строкой на всю ширину под заголовком", async ({ page, request }) => {
    await deed(request, "Подготовить договор для подрядчика", day(0));
    await page.goto("/#board");
    await expect(boardNumber(page, "planned")).toHaveText("1");
    const heading = await page.locator(".board-page h2").boundingBox();
    const wrap = await board(page).locator(".metric-wrap").boundingBox();
    expect(wrap.y).toBeGreaterThanOrEqual(heading.y + heading.height);
    expect(wrap.x).toBeGreaterThanOrEqual(0);
    expect(wrap.x + wrap.width).toBeLessThanOrEqual(390);
    const controls = await page.locator("#board .board-controls").boundingBox();
    expect(Math.abs(wrap.width - controls.width)).toBeLessThan(2);
    // Полоска — в потоке под пилюлей, ни на что не налезает.
    const strip = await board(page).locator(".metric-wrap > .metric-strip").boundingBox();
    const pillBox = await board(page).locator(".metric-pill").boundingBox();
    expect(strip.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height);
    expect(strip.y + strip.height).toBeLessThanOrEqual(controls.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
