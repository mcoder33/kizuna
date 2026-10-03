import { test, expect } from '@playwright/test';

const beforeMidnight = new Date('2026-10-02T19:59:30Z'); // Samara, 23:59.
const nextMorning = new Date('2026-10-03T05:00:00Z');

test.beforeEach(async ({ page, request }) => {
  // A delayed SSE ready reload could otherwise mask the broken midnight timer.
  await page.addInitScript(() => { delete window.EventSource; });
  await request.put('/api/settings', { data: { requestedTimeZone: 'Europe/Samara', locale: 'ru' } });
  await page.clock.install({ time: beforeMidnight });
  await page.route('**/api/day', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.date = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Samara', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()));
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  await expect(page.locator('#today-date')).toContainText('2 октября');
});

test('midnight refreshes today even with an unsent draft', async ({ page }) => {
  await page.locator('#capture-input').fill('Не потерять этот черновик');
  await page.clock.fastForward(61_000);
  await expect(page.locator('#today-date')).toContainText('3 октября');
  await expect(page.locator('#capture-input')).toHaveText('Не потерять этот черновик');
});

for (const event of ['focus', 'pageshow', 'pagent:resume', 'visibilitychange']) {
  test(`${event} catches up after sleep without waiting for the minute timer`, async ({ page }) => {
    await page.clock.setSystemTime(nextMorning);
    await page.evaluate(event => (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event)), event);
    await expect(page.locator('#today-date')).toContainText('3 октября');
  });
}

test('a failed day refresh is retried on the next wake event', async ({ page }) => {
  await page.clock.setSystemTime(nextMorning);
  await page.route('**/api/day', route => route.abort(), { times: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#today-date')).toContainText('2 октября');
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    return page.locator('#today-date').textContent();
  }).toContain('3 октября');
});
