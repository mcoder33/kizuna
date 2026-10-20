import { test, expect, devices } from '@playwright/test';

async function completedTask(context, date, raw, { priority, subtasks = false } = {}) {
  const response = await context.request.post('/api/captures', { data: { raw, due: { date }, ...(priority ? { priority } : {}) } });
  expect(response.status()).toBe(201);
  const { entry } = await response.json();
  if (subtasks) expect((await context.request.post(`/api/captures/${entry.id}/subtasks`, { data: { title: 'Проверить результат' } })).status()).toBe(201);
  const projection = entry.projections.find(item => item.type === 'task');
  expect(projection).toBeTruthy();
  expect((await context.request.post(`/api/projections/${projection.id}/complete`, { data: {} })).ok()).toBe(true);
  return entry;
}

async function openJournal(page) {
  const calendar = page.waitForResponse(response => response.url().includes('/api/calendar?'));
  const done = page.waitForResponse(response => response.url().includes('/api/done?'));
  if (new URL(page.url()).hash === '#today') await page.reload();
  else await page.goto('/#today');
  await expect(page.locator('#capture-input')).toBeEditable();
  await expect(page.locator('#account-summary')).toHaveAttribute('title', /@/);
  await Promise.all([calendar, done]);
  const journalTab = page.locator('#tab-journal');
  if (await journalTab.getAttribute('aria-selected') !== 'true') await journalTab.click();
  await expect(page.locator('#journal')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function classicTitleContrast(title) {
  return title.evaluate(element => {
    if (!element.isConnected || !element.getClientRects().length) return 0;
    const channels = color => color.match(/[\d.]+/g).map(Number);
    const composite = (foreground, background) => {
      const alpha = foreground[3] ?? 1;
      return foreground.slice(0, 3).map((value, index) => value * alpha + background[index] * (1 - alpha));
    };
    const ancestors = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) ancestors.push(ancestor);
    let background = [255, 255, 255];
    for (const ancestor of ancestors.reverse()) background = composite(channels(getComputedStyle(ancestor).backgroundColor), background);
    const foreground = composite(channels(getComputedStyle(element).color), background);
    const luminance = color => color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const light = luminance(foreground), dark = luminance(background);
    return (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05);
  });
}

async function expectReachable(target) {
  const centerHitsTarget = () => target.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || element.contains(hit);
  });
  await target.scrollIntoViewIfNeeded();
  if (!await centerHitsTarget()) {
    await target.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  }
  await expect.poll(centerHitsTarget, 'Journal action must be reachable above the fixed dock').toBe(true);
}

for (const [name, device] of [
  ['mobile', devices['iPhone SE']],
  ['tablet', devices['iPad Mini']],
  ['desktop-960', { viewport: { width: 960, height: 1000 } }],
  ['desktop-1440', { viewport: { width: 1440, height: 1000 } }],
]) test(`${name}: completed journal stays light, readable and operable`, async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ ...device, baseURL, locale: 'ru-RU', timezoneId: 'Europe/Samara' });
  try {
    expect((await context.request.post('/api/auth/register', { data: { email: `journal-${crypto.randomUUID()}@kizuna.test`, password: 'journal-test-password' } })).status()).toBe(201);
    const { userId } = await (await context.request.get('/api/ui-preferences')).json();
    const date = (await (await context.request.get('/api/day')).json()).date;
    const short = await completedTask(context, date, 'Проверить отчёт');
    const long = await completedTask(context, date, 'Согласовать результаты проверки новой инфраструктуры и подготовить описание следующих шагов для команды', { priority: 'highest' });
    const unbroken = await completedTask(context, date, 'Проверить чрезвычайнодлинноеназваниепроверкибезпробеловчрезвычайнодлинноеназваниепроверкибезпробелов');
    const parent = await completedTask(context, date, 'Подготовить выпуск', { priority: 'high', subtasks: true });
    const page = await context.newPage();
    await page.clock.install({ time: new Date(`${date}T09:00:00Z`) });
    const row = id => page.locator(`#journal .entry[data-capture-id="${id}"]`);
    for (const appearance of ['workshop', 'classic']) for (const theme of ['light', 'dark']) {
      expect((await context.request.patch('/api/ui-preferences', { data: { userId, changes: { 'kizuna-appearance': appearance, 'kizuna-room-season': 'autumn' } } })).ok()).toBe(true);
      expect((await context.request.put('/api/settings', { data: { theme, locale: 'ru' } })).ok()).toBe(true);
      await openJournal(page);
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const entry of [short, long, unbroken, parent]) await expect(row(entry.id)).toBeVisible();
      await expect(row(long.id).locator('.importance-mark')).toHaveAttribute('data-importance', 'highest');
      await expect(row(parent.id).locator('.sub-badge')).toBeVisible();
      await expect(row(unbroken.id).locator('.entry-title')).toContainText('чрезвычайнодлинноеназваниепроверкибезпробелов');
      // Move off the list so this checks the resting surface rather than hover.
      await page.mouse.move(0, 0);
      await expect(async () => {
        const facts = await page.locator('#journal .entry[data-capture-id]').evaluateAll(rows => rows.map(row => {
          if (!row.isConnected || !row.getClientRects().length) return { connected: false };
          const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, right: r.right, height: r.height, width: r.width }; };
          const title = row.querySelector('.entry-title'), complete = row.querySelector('.completion-button');
          const style = getComputedStyle(row);
          return { connected: true, row: rect(row), title: rect(title), complete: rect(complete), background: getComputedStyle(row).backgroundColor,
            titleClipped: title.scrollWidth > title.clientWidth + 1 || title.scrollHeight > title.clientHeight + 1,
            visibleBoundary: row.previousElementSibling?.classList.contains('entry')
              ? parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none' && !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.borderTopColor)
              : null,
            overflow: row.scrollWidth > row.clientWidth + 1 };
        }));
        expect(facts).toHaveLength(4);
        for (const fact of facts) {
          expect(fact.connected).toBe(true);
          expect(fact.background).toBe('rgba(0, 0, 0, 0)');
          expect(fact.complete.height).toBeGreaterThanOrEqual(44);
          expect(fact.complete.width).toBeGreaterThanOrEqual(44);
          expect(fact.title.height).toBeGreaterThanOrEqual(44);
          expect(fact.complete.right).toBeLessThanOrEqual(fact.title.x);
          expect(fact.titleClipped).toBe(false);
          expect(fact.overflow).toBe(false);
          if (fact.visibleBoundary !== null) expect(fact.visibleBoundary).toBe(true);
        }
        expect(facts.filter(fact => fact.visibleBoundary === true).length).toBeGreaterThanOrEqual(3);
      }).toPass({ timeout: 15_000 });
      await expect.poll(async () => (await row(short.id).boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(57);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      if (appearance === 'classic') {
        const title = row(short.id).locator('.entry-title');
        await expect.poll(() => classicTitleContrast(title).catch(() => 0)).toBeGreaterThanOrEqual(4.5);
        await title.hover();
        await expect.poll(() => classicTitleContrast(title).catch(() => 0)).toBeGreaterThanOrEqual(4.5);
        await page.mouse.move(0, 0);
      }
      await page.locator('#journal').screenshot({ path: testInfo.outputPath(`journal-${appearance}-${theme}.png`) });
      if (name === 'mobile') {
        const lastRow = page.locator('#journal .entry[data-capture-id]').last();
        await expectReachable(lastRow.locator('.entry-title'));
        await expectReachable(lastRow.locator('.completion-button'));
        const lastBadge = lastRow.locator('.sub-badge');
        if (await lastBadge.count()) await expectReachable(lastBadge);
        await expectReachable(row(parent.id).locator('.sub-badge'));
      }
    }
    await row(short.id).locator('.entry-title').press('Enter');
    await expect(page.locator('#review-dialog')).toBeVisible();
    await page.locator('#review-close').click();
    await expect(page.locator('#review-dialog')).not.toBeVisible();
    const completion = row(short.id).locator('.completion-button');
    await completion.press('Space');
    await expect(row(short.id)).toHaveCount(0);
    const reopened = (await (await context.request.get(`/api/captures/${short.id}`)).json()).entry;
    expect(reopened.projections.filter(item => item.type === 'task').every(item => !item.completion.completed)).toBe(true);
  } finally { await context.close(); }
});
