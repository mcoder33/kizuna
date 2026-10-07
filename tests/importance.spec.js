import { test, expect, devices } from '@playwright/test';

async function account(browser, baseURL, device = {}) {
  const context = await browser.newContext({ ...device, baseURL, locale: 'ru-RU', timezoneId: 'Europe/Samara' });
  expect((await context.request.post('/api/auth/register', { data: { email: `importance-${crypto.randomUUID()}@kizuna.test`, password: 'importance-test-password' } })).status()).toBe(201);
  const { userId } = await (await context.request.get('/api/ui-preferences')).json();
  expect((await context.request.patch('/api/ui-preferences', { data: { userId, changes: { 'kizuna-appearance': 'workshop', 'kizuna-room-season': 'autumn' } } })).ok()).toBe(true);
  const date = (await (await context.request.get('/api/day')).json()).date;
  const page = await context.newPage();
  await page.clock.install({ time: new Date(`${date}T09:00:00Z`) });
  return { context, page, date };
}
async function capture(context, date, raw, priority) {
  const response = await context.request.post('/api/captures', { data: { raw, due: { date }, ...(priority ? { priority } : {}) } });
  expect(response.status()).toBe(201);
  return (await response.json()).entry;
}
async function ready(page) {
  const calendar = page.waitForResponse(response => response.url().includes('/api/calendar?'));
  const done = page.waitForResponse(response => response.url().includes('/api/done?'));
  if (new URL(page.url()).hash === '#today') await page.reload();
  else await page.goto('/#today');
  await expect(page.locator('#capture-input')).toBeEditable();
  await expect(page.locator('#account-summary')).toHaveAttribute('title', /@/);
  await Promise.all([calendar, done]);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const tab = page.getByRole('tab', { name: /^День/ });
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
}
const row = (page, id) => page.locator(`#todo .entry[data-capture-id="${id}"]`);
const current = page => page.locator('#review-dialog .importance-current');
const choice = (page, priority) => page.locator(`#review-dialog .importance-choice[data-importance="${priority}"]`);
async function choose(page, priority) {
  await current(page).click();
  await choice(page, priority).click();
  await expect(current(page)).toBeEnabled();
  await expect(current(page)).toHaveAttribute('aria-expanded', 'false');
}

test('four levels persist, repeated choices save again, and a failed save keeps the saved flag', async ({ browser, baseURL }) => {
  const { context, page, date } = await account(browser, baseURL, devices['iPhone 13']);
  try {
    const entry = await capture(context, date, 'Проверить встречи 1-1', 'high');
    await capture(context, date, 'Посчитать премии', 'highest');
    await ready(page);
    await expect(row(page, entry.id)).toBeVisible();
    const order = await page.locator('#todo .entry').evaluateAll(rows => rows.map(r => r.dataset.captureId));
    await row(page, entry.id).locator('.entry-title').click();
    await current(page).click();
    await expect(page.locator('.importance-choice')).toHaveCount(4);
    await page.keyboard.press('Home');
    await expect(choice(page, 'highest')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#review-dialog')).toBeVisible();
    await expect(current(page)).toBeFocused();
    for (const priority of ['highest', 'low', 'high', 'highest', 'normal', 'highest']) {
      await choose(page, priority);
      await expect(current(page).locator('.importance-mark')).toHaveAttribute('data-importance', priority);
      const saved = (await (await context.request.get(`/api/captures/${entry.id}`)).json()).entry;
      expect(saved.interpretation.classification.priority || 'normal').toBe(priority);
      expect(saved.interpretation.classification.entities.schedule.date).toBe(date);
      expect(saved.projections.some(p => p.completion.completed)).toBe(false);
    }
    await page.route(`**/api/captures/${entry.id}/corrections`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Не удалось сохранить важность' } }) }));
    await current(page).click(); await choice(page, 'low').click();
    await expect(choice(page, 'low')).toBeEnabled();
    await expect(current(page).locator('.importance-mark')).toHaveAttribute('data-importance', 'highest');
    await expect(choice(page, 'highest')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#toast')).toContainText('Не удалось сохранить важность');
    await page.unroute(`**/api/captures/${entry.id}/corrections`);
    await choice(page, 'low').click();
    await expect(current(page)).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#review-close').click();
    expect(await page.locator('#todo .entry').evaluateAll(rows => rows.map(r => r.dataset.captureId))).toEqual(order);
    await page.reload();
    await expect(row(page, entry.id).locator('.importance-mark')).toHaveAttribute('data-importance', 'low');
    await row(page, entry.id).locator('.todo-tomorrow').click();
    await expect(row(page, entry.id)).toHaveCount(0);
    const moved = (await (await context.request.get(`/api/captures/${entry.id}`)).json()).entry;
    expect(moved.interpretation.classification.priority).toBe('low');
    expect(moved.interpretation.classification.entities.schedule.date).not.toBe(date);
    expect(moved.projections.some(p => p.completion.completed)).toBe(false);
  } finally { await context.close(); }
});

for (const [name, device] of [
  ['mobile', devices['iPhone 13']],
  ['small', { ...devices['iPhone SE'], viewport: { width: 320, height: 740 } }],
  ['tablet', devices['iPad Mini']],
  ['desktop', { viewport: { width: 1440, height: 1000 } }],
]) test(`${name}: compact rows, long titles and separate targets in both appearances and themes`, async ({ browser, baseURL }, testInfo) => {
  const { context, page, date } = await account(browser, baseURL, device);
  try {
    const normal = await capture(context, date, 'Сделать МСП');
    const high = await capture(context, date, 'Проверить встречи 1-1', 'high');
    const top = await capture(context, date, 'Посчитать премии', 'highest');
    const low = await capture(context, date, 'Отремонтировать зеркало', 'low');
    const long = await capture(context, date, 'Рассчитать стоимость запуска прозвонов через ВойсОпс на ЗБ и согласовать чрезвычайнодлинноеназваниепроверкибезпробелов', 'highest');
    await capture(context, date, '**Обсудить Communication Policy** с Ильюхиным', 'high');
    const sub = await capture(context, date, 'Допинываем карусель с генератором фраз');
    expect((await context.request.post(`/api/captures/${sub.id}/subtasks`, { data: { title: 'Подготовить примеры' } })).status()).toBe(201);
    const { userId } = await (await context.request.get('/api/ui-preferences')).json();
    for (const appearance of ['workshop', 'classic']) for (const theme of ['light', 'dark']) {
      expect((await context.request.patch('/api/ui-preferences', { data: { userId, changes: { 'kizuna-appearance': appearance } } })).ok()).toBe(true);
      expect((await context.request.put('/api/settings', { data: { theme, locale: 'ru' } })).ok()).toBe(true);
      await ready(page);
      await expect(row(page, normal.id)).toBeVisible();
      await expect(row(page, long.id).locator('.entry-title')).toContainText('чрезвычайнодлинноеназваниепроверкибезпробелов');
      await expect(row(page, sub.id).locator('.sub-badge')).toBeVisible();
      expect(await row(page, normal.id).locator('.importance-mark svg').count()).toBe(0);
      for (const [entry, priority] of [[high, 'high'], [top, 'highest'], [low, 'low']])
        await expect(row(page, entry.id).locator('.importance-mark')).toHaveAttribute('data-importance', priority);
      const facts = await page.locator('#todo .entry').evaluateAll(rows => rows.map(row => {
        const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, height: r.height, width: r.width }; };
        const button = row.querySelector('.completion-button'), title = row.querySelector('.entry-title'), move = row.querySelector('.todo-tomorrow');
        return { row: rect(row), box: rect(button), title: rect(title), move: rect(move), border: getComputedStyle(button).borderTopWidth, circle: getComputedStyle(button, '::before').width, clipping: title.scrollWidth > title.clientWidth + 1, overflow: row.scrollWidth > row.clientWidth + 1 };
      }));
      for (const f of facts) {
        expect(f.box.height).toBe(44); expect(f.box.width).toBe(44);
        expect(f.border).toBe('0px'); expect(f.circle).toBe('18px');
        expect(f.title.height).toBeGreaterThanOrEqual(44); expect(f.move.height).toBe(44);
        expect(f.box.right).toBeLessThanOrEqual(f.title.x); expect(f.title.right).toBeLessThanOrEqual(f.move.x);
        expect(f.clipping).toBe(false); expect(f.overflow).toBe(false);
      }
      await expect.poll(async () => (await row(page, normal.id).boundingBox())?.height || 1000).toBeLessThanOrEqual(57);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      if (name === 'mobile' && appearance === 'workshop') {
        await page.locator('#todo').screenshot({ path: testInfo.outputPath(`rows-${theme}.png`) });
        await row(page, top.id).locator('.entry-title').click();
        await current(page).click();
        await page.locator('#review-dialog').screenshot({ path: testInfo.outputPath(`picker-${theme}.png`) });
        await page.keyboard.press('Escape'); await page.locator('#review-close').click();
      }
    }
    await row(page, low.id).locator('.completion-button').click();
    await expect(row(page, low.id)).toHaveCount(0);
    const closed = (await (await context.request.get(`/api/captures/${low.id}`)).json()).entry;
    expect(closed.interpretation.classification.priority).toBe('low');
    expect(closed.projections.some(p => p.completion.completed)).toBe(true);
    expect(closed.interpretation.classification.entities.schedule.date).toBe(date);
    await page.goto('/#done');
    await expect(page.locator(`#done .entry[data-capture-id="${low.id}"] .importance-mark`)).toHaveAttribute('data-importance', 'low');
  } finally { await context.close(); }
});
