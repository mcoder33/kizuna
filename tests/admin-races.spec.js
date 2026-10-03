import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// The server supplies the real response; only its arrival in this tab is held.
async function holdFirstGet(page, path) {
  const requested = deferred(), release = deferred(), completed = deferred();
  let held = false;
  await page.route(`**${path}`, async route => {
    if (held || route.request().method() !== 'GET') return route.continue();
    held = true; requested.resolve();
    try {
      const response = await route.fetch();
      await release.promise;
      await route.fulfill({ response });
    } finally { completed.resolve(); }
  });
  return { requested: requested.promise, completed: completed.promise, release: release.resolve };
}

async function createFeedback(request, text) {
  const response = await request.post('/api/feedback', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { text, allowContact: true },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).feedback;
}

const feedbackCard = (page, id) => page.locator(`#admin-feedback-list [data-feedback-id="${id}"]`);
const notificationPreferences = {
  signup: { app: true, telegram: true },
  feedback: { app: true, telegram: true },
};

test.beforeEach(async ({ request }) => {
  expect((await request.put('/api/settings', { data: { locale: 'ru' } })).status()).toBe(200);
  expect((await request.put('/api/admin/notification-settings', { data: { preferences: notificationPreferences } })).status()).toBe(200);
});

test.afterEach(async ({ request }) => {
  // Restore the shared administrator through its fixture, independently of page sessions.
  expect((await request.put('/api/settings', { data: { locale: 'ru' } })).status()).toBe(200);
  expect((await (await request.get('/api/settings')).json()).settings.locale).toBe('ru');
});

test('поздний ответ списка пользователей сохраняет ответ, который уже пишут в обратной связи', async ({ page, request }) => {
  const feedback = await createFeedback(request, `Пожелание для проверки позднего ответа ${randomUUID()}`);
  const held = await holdFirstGet(page, '/api/admin/users');
  try {
    await page.goto('/#admin/users');
    await held.requested;
    await page.locator('.admin-sidebar [data-admin-section="feedback"]').click();
    const card = feedbackCard(page, feedback.id);
    await expect(card).toBeVisible();
    const draft = 'Ответ ещё не отправлен — не терять при загрузке другого раздела.';
    await card.getByLabel('Ответ пользователю').fill(draft);
    await card.getByLabel('Статус пожелания').selectOption('considering');

    // loadUsers finishes its history request after rendering the old user list.
    const history = page.waitForResponse(response => response.url().includes('/api/admin/auth-events'));
    held.release();
    await held.completed;
    await (await history).finished();
    await expect(page.locator('#admin-events .admin-event').first()).toBeAttached();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    await expect(page).toHaveURL(/#admin\/feedback$/);
    await expect(page.locator('#admin-title')).toHaveText('Обратная связь');
    await expect(card.getByLabel('Ответ пользователю')).toHaveValue(draft);
    await expect(card.getByLabel('Статус пожелания')).toHaveValue('considering');
    expect((await (await request.get(`/api/admin/feedback/${feedback.id}`)).json()).feedback.replies).toEqual([]);
  } finally { held.release(); }
});

test('новая заявка и пожелание через SSE не сбрасывают несохранённый выбор уведомлений', async ({ page, request }) => {
  // Observe the real administration event, without replacing the event stream.
  await page.addInitScript(() => {
    window.administrationEvents = 0;
    window.administrationStreams = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        window.administrationStreams.push(this);
        this.addEventListener('administration', () => { window.administrationEvents += 1; });
      }
    };
  });
  await page.goto('/#admin/service/notifications');
  const checkbox = page.locator('#admin-delivery-settings input[name="signup:telegram"]');
  await expect(checkbox).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.administrationStreams.some(stream => stream.readyState === EventSource.OPEN))).toBe(true);
  await checkbox.uncheck();
  const beforeSignup = await page.evaluate(() => window.administrationEvents);
  const email = `race-signup-${randomUUID()}@kizuna.test`;
  expect((await request.post('/api/auth/register', { data: { email, password: 'admin-race-registration-password' } })).status()).toBe(201);
  await expect.poll(() => page.evaluate(() => window.administrationEvents)).toBeGreaterThan(beforeSignup);
  await expect(page.locator('#admin-notices')).toContainText(email);
  await expect(checkbox).not.toBeChecked();

  const beforeFeedback = await page.evaluate(() => window.administrationEvents);
  const text = `Пожелание во время настройки уведомлений ${randomUUID()}`;
  await createFeedback(request, text);
  await expect.poll(() => page.evaluate(() => window.administrationEvents)).toBeGreaterThan(beforeFeedback);
  await expect(page.locator('#admin-notices')).toContainText(text);
  await expect(checkbox).not.toBeChecked();
  expect((await (await request.get('/api/admin/notification-settings')).json()).preferences.signup.telegram).toBe(true);
});

test('поля пожелания становятся доступны только после загрузки учётной записи', async ({ page }) => {
  const held = await holdFirstGet(page, '/api/auth/me');
  try {
    await page.goto('/#feedback');
    await held.requested;
    const input = page.locator('#feedback-text'), contact = page.locator('#feedback-contact');
    const submit = page.locator('#feedback-form button[type="submit"]');
    await expect(page.locator('#feedback')).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(contact).toBeDisabled();
    await expect(submit).toBeDisabled();

    held.release();
    await held.completed;
    await expect(input).toBeEnabled();
    await expect(contact).toBeEnabled();
    await expect(submit).toBeEnabled();
    await input.fill('Теперь можно написать пожелание без потери текста.');
    await contact.check();
    await expect(input).toHaveValue('Теперь можно написать пожелание без потери текста.');
    await expect(contact).toBeChecked();
  } finally { held.release(); }
});

test('смена языка сохраняет несохранённый ответ и статус пожелания', async ({ page, request }) => {
  const feedback = await createFeedback(request, `Пожелание для смены языка ${randomUUID()}`);
  await page.goto(`/#admin/feedback?id=${feedback.id}`);
  const card = feedbackCard(page, feedback.id);
  const draft = 'Личный ответ <script> и **markdown** остаётся как написан.';
  await card.getByLabel('Ответ пользователю').fill(draft);
  await card.getByLabel('Статус пожелания').selectOption('later');

  const repainted = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/admin/feedback');
  // The administration shell uses the same browser locale event as the header.
  await page.evaluate(async () => { const { setLocale } = await import('/public/browser-i18n.js'); setLocale('en'); });
  await (await repainted).finished();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#admin-title')).toHaveText('Feedback');
  await expect(card.getByLabel('Reply to the user')).toHaveValue(draft);
  await expect(card.getByLabel('Suggestion status')).toHaveValue('later');
  expect((await (await request.get(`/api/admin/feedback/${feedback.id}`)).json()).feedback).toMatchObject({ status: 'new', replies: [] });
});

test('пользовательский черновик и разрешение уточнить детали переживают смену языка', async ({ page, request }) => {
  await page.goto('/#feedback');
  const input = page.locator('#feedback-text'), contact = page.locator('#feedback-contact');
  const draft = 'Моё пожелание <script> и **markdown** не переводится.';
  await input.fill(draft);
  await contact.check();
  await page.locator('[data-language-control] .language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).settings.locale).toBe('en');
  await expect(input).toHaveValue(draft);
  await expect(contact).toBeChecked();

  await page.reload();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue(draft);
  await expect(contact).toBeChecked();
});
