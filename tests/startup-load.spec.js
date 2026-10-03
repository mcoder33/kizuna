import { test, expect } from '@playwright/test';

test('Today paints after its core requests while calendar and closed items are slow', async ({ page }) => {
  let releaseCore;
  let releaseCalendar;
  let releaseDone;
  const core = new Promise(resolve => { releaseCore = resolve; });
  const calendar = new Promise(resolve => { releaseCalendar = resolve; });
  const done = new Promise(resolve => { releaseDone = resolve; });
  let dayRequests = 0;
  let calendarRequests = 0;
  let doneRequests = 0;
  let calendarResponses = 0;
  let doneResponses = 0;
  page.on('response', response => {
    if (response.url().includes('/api/calendar?')) calendarResponses += 1;
    if (response.url().includes('/api/done?')) doneResponses += 1;
  });

  // Reproduce the stream greeting arriving before the first /api/day response.
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor() {
        super();
        setTimeout(() => {
          window.__journalReadyCount = (window.__journalReadyCount || 0) + 1;
          this.dispatchEvent(new Event('ready'));
        }, 0);
      }
      close() {}
    };
  });
  await page.route('**/api/day', async route => {
    dayRequests += 1;
    await core;
    await route.continue();
  });
  await page.route('**/api/entries?limit=100', async route => {
    await core;
    await route.continue();
  });
  await page.route(/\/api\/(calendar|done)\?/, async route => {
    if (route.request().url().includes('/api/calendar?')) {
      calendarRequests += 1;
      await calendar;
    } else {
      doneRequests += 1;
      await done;
    }
    await route.continue();
  });

  try {
    await page.goto('/#today');
    await expect.poll(() => page.evaluate(() => window.__journalReadyCount || 0)).toBe(1);
    await page.waitForTimeout(180);
    expect(dayRequests).toBe(1);

    releaseCore();
    await expect(page.locator('#tab-day')).toBeVisible();
    await expect(page.locator('#tab-journal')).toBeVisible();
    // The greeting still reconciles changes made between HTML load and stream connection.
    await expect.poll(() => dayRequests).toBe(2);
    await expect.poll(() => calendarRequests).toBe(2);
    await expect.poll(() => doneRequests).toBe(2);
    await page.locator('#today-tabs [aria-selected="true"]').click();
    await expect(page.locator('#today-brief')).toHaveText('Загружаю…');
    await expect(page.locator('#tab-journal b')).toHaveText('…');
    await expect(page.locator('#journal .empty')).toHaveText('Загружаю…');
    await page.locator('#capture-input').fill('Черновик при загрузке календаря');
    await page.locator('#tab-day').click();
    await page.locator('#todo .daynav-step.next').focus();
    releaseCalendar();
    await expect.poll(() => calendarResponses).toBe(2);
    expect(await page.locator('#todo .daynav-step.next').evaluate(element => document.activeElement === element)).toBe(true);
    await page.locator('#tab-day').click();
    await expect(page.locator('#today-brief')).toHaveText('Загружаю…');
    await page.locator('#tab-day').focus();
    expect(await page.locator('#tab-day').evaluate(element => document.activeElement === element)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.locator('#tab-day')).toHaveAttribute('aria-selected', 'true');

    // A late /api/done response used to replace the pressed tab button before
    // pointerup, losing the click. It must update the same target in place.
    const label = await page.locator('#tab-day .drawer-tab-label').boundingBox();
    await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
    await page.mouse.down();
    releaseDone();
    await expect.poll(() => doneResponses).toBe(2);
    await expect(page.locator('#tab-journal b')).not.toHaveText('…');
    await page.mouse.up();
    await expect(page.locator('#tab-day')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#capture-input')).toHaveText('Черновик при загрузке календаря');
    await page.waitForTimeout(200);
    expect(calendarRequests).toBe(2);
    expect(doneRequests).toBe(2);
  } finally {
    releaseCore();
    releaseCalendar();
    releaseDone();
  }
});
