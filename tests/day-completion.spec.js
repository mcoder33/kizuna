import { test, expect, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { E2E_STORAGE } from './fixtures/e2e-account.js';

const circle = button => button.evaluate(el => {
  const style = getComputedStyle(el, '::before');
  return { background: style.backgroundColor, color: style.color };
});

for (const repeating of [false, true]) {
  test(`Day circle responds before saving and recovers after failure (${repeating ? 'repeat' : 'task'})`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, storageState: E2E_STORAGE, locale: 'ru-RU', timezoneId: 'Europe/Samara' });
    try {
      const { userId } = await (await context.request.get('/api/ui-preferences')).json();
      expect((await context.request.patch('/api/ui-preferences', { data: { userId, changes: {
        'kizuna-appearance': 'workshop', 'pagent.theme': 'dark', 'kizuna-room-season': 'autumn',
      } } })).ok()).toBe(true);
      const { date } = await (await context.request.get('/api/day')).json();
      const created = await context.request.post('/api/captures', { data: { raw: 'Подготовить отчёт для проверки кружка', due: { date } } });
      expect(created.status()).toBe(201);
      const { entry } = await created.json();
      if (repeating) expect((await context.request.post(`/api/captures/${entry.id}/corrections`, { data: {
        at: Date.now(), patch: { schedule: { date, time: null, repeat: { freq: 'daily', interval: 1 } } },
      } })).ok()).toBe(true);
      const page = await context.newPage();
      // Background refresh must not hide a failed completion by replacing its row.
      await page.addInitScript(() => { delete window.EventSource; });
      await page.clock.install({ time: new Date(`${date}T09:00:00Z`) });
      const loaded = [
        page.waitForResponse(response => response.url().includes('/api/calendar?')),
        page.waitForResponse(response => response.url().includes('/api/done?')),
      ];
      await page.goto('/#today');
      await Promise.all(loaded);
      const row = page.locator(`#todo .entry[data-capture-id="${entry.id}"]`);
      const button = row.getByRole('button', { name: 'Готово', exact: true });
      await expect(button).toBeVisible();
      await expect.poll(async () => (await circle(button)).background).toBe('rgba(0, 0, 0, 0)');
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      let calls = 0;
      await page.route('**/api/projections/*/complete', async route => {
        calls += 1;
        await pending;
        await route.fulfill({ status: 503, json: { error: { message: 'Не удалось сохранить завершение' } } });
      });
      try {
        await button.click();
        await expect(button).toBeDisabled();
        await expect(row.locator('.entry-title')).toHaveCSS('text-decoration-line', 'line-through');
        await expect.poll(async () => (await circle(button)).background).not.toBe('rgba(0, 0, 0, 0)');
        await expect.poll(async () => (await circle(button)).color).not.toBe('rgba(0, 0, 0, 0)');
        await button.evaluate(el => el.click());
        expect(calls).toBe(1);
        await page.screenshot({ path: `tmp/screenshots/day-circle-${repeating ? 'repeat' : 'task'}.png` });
      } finally { release(); }
      await expect(button).toBeEnabled();
      await expect(row).not.toHaveClass(/completing/);
      await expect(row.locator('.entry-title')).not.toHaveCSS('text-decoration-line', 'line-through');
      expect((await circle(button)).background).toBe('rgba(0, 0, 0, 0)');
      await page.unroute('**/api/projections/*/complete');
      await button.click();
      await expect(row).toHaveCount(0);
      await page.reload();
      await expect(row).toHaveCount(0);
    } finally { await context.close(); }
  });
}

test('Day circle keeps its appearance and geometry across themes and devices', async ({ browser }) => {
  const html = readFileSync('public/app.html', 'utf8');
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/public\/([^"]+)"/g)]
    .map(match => readFileSync(`public/${match[1]}`, 'utf8')).join('\n');
  for (const device of [{ viewport: { width: 1440, height: 900 } }, { viewport: { width: 768, height: 1024 } }, devices['iPhone SE']]) {
    const context = await browser.newContext(device);
    const page = await context.newPage();
    await page.setContent('<html><body><section id="today"><div id="todo"><div class="entry dense importance-row completable overdue"><button class="completion-button" aria-pressed="false"></button><button class="entry-title">Проверить кружок</button></div></div></section></body></html>');
    await page.addStyleTag({ content: styles });
    for (const appearance of ['workshop', 'classic']) for (const theme of ['dark', 'light']) {
      await page.evaluate(({ appearance, theme }) => Object.assign(document.documentElement.dataset, { appearance, theme }), { appearance, theme });
      const row = page.locator('.entry'), button = row.locator('.completion-button');
      const before = await button.boundingBox();
      await row.evaluate(el => el.classList.add('completing'));
      expect((await circle(button)).background).not.toBe('rgba(0, 0, 0, 0)');
      expect((await circle(button)).color).not.toBe('rgba(0, 0, 0, 0)');
      expect(await button.boundingBox()).toEqual(before);
      await row.evaluate(el => el.classList.remove('completing'));
      expect((await circle(button)).background).toBe('rgba(0, 0, 0, 0)');
    }
    await context.close();
  }
});
