import { test, expect } from '@playwright/test';

test('calendar rejects unsafe stored URLs and retains valid external links', async ({ page, request }) => {
  const today = (await (await request.get('/api/day')).json()).date;
  const event = (id, title, url) => ({ id, kind: 'external', accountId: 'fixture', calendarId: 'fixture', calendarName: 'Fixture', source: 'Fixture', title, date: today, time: '10:00', end: '11:00', allDay: false, busy: true, readOnly: true, editable: false, movable: false, attendees: [], href: url, url, joinUrl: url });
  await page.addInitScript(() => localStorage.setItem('kizuna-calendar-mode', 'day'));
  // Deliberately bypass API sanitization to cover already cached browser records too.
  await page.route('**/api/calendar?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.external = [event('ext:unsafe', 'Unsafe cached event', 'javascript:alert(1)'), event('ext:safe', 'Safe cached event', 'https://meet.google.com/fixture')];
    await route.fulfill({ response, json: body });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#calendar');
  const unsafe = page.locator('.cal-ev.external', { hasText: 'Unsafe cached event' }).first();
  await expect(unsafe).toBeVisible();
  await expect(unsafe.locator('a')).toHaveCount(0);
  await unsafe.click();
  const popover = page.locator('.cal-pop.rich');
  await expect(popover).toBeVisible();
  await expect(popover.locator('a')).toHaveCount(0);
  if (process.env.PAGENT_SECURITY_QA_SCREENSHOT) await page.screenshot({ path: process.env.PAGENT_SECURITY_QA_SCREENSHOT });
  await page.keyboard.press('Escape');
  await page.locator('.cal-ev.external[data-id="ext:safe"]').first().locator('b').click();
  await expect(popover.locator('a').first()).toHaveAttribute('href', 'https://meet.google.com/fixture');
  expect(errors).toEqual([]);
});
