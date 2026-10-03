import { test, expect } from '@playwright/test';

// CI uses the configured authenticated app fixture; this test needs an HTTP server.
test('dated Telegram hash waits for real day data and updates both day views on later navigation', async ({ page, request }) => {
  await page.addInitScript(() => { delete window.EventSource; });
  await request.put('/api/settings', { data: { requestedTimeZone: 'Europe/Samara', locale: 'ru' } });
  await page.clock.install({ time: new Date('2026-10-03T05:15:00Z') });
  let releaseDay, dayRequested;
  const blocked = new Promise(resolve => { releaseDay = resolve; });
  const requested = new Promise(resolve => { dayRequested = resolve; });
  await page.route('**/api/day', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.date = '2026-10-03';
    dayRequested();
    await blocked;
    await route.fulfill({ response, json: data });
  });
  await page.goto('/#today?date=2026-10-01', { waitUntil: 'domcontentloaded' });
  await requested;
  releaseDay();
  await expect(page.locator('#today-date')).toContainText('3 октября');
  await expect(page.locator('#tab-day')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#todo .daynav-current b')).toContainText('1 октября');
  await expect(page.locator('#tab-journal .drawer-tab-label')).toHaveText(/Закрыто.*чт.*1/);
  await page.evaluate(() => { location.hash = '#today?date=2026-10-02'; });
  await expect(page.locator('#todo .daynav-current b')).toContainText('2 октября');
  await expect(page.locator('#tab-journal .drawer-tab-label')).toHaveText(/Закрыто.*пт.*2/);
  await expect(page.locator('#today-date')).toContainText('3 октября');
  await page.evaluate(() => { location.hash = '#today?date=2026-02-30'; });
  await expect(page.locator('#todo .daynav-current b')).toContainText('2 октября');
  await expect(page.locator('#tab-day')).toHaveAttribute('aria-selected', 'true');
});
