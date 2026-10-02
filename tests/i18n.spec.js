import { test, expect } from '@playwright/test';

const email = 'i18n-web@kizuna.test';
const password = 'i18n-web-password-123';
async function login(page) {
  const state = await (await page.request.get('/api/auth/state')).json();
  const response = await page.request.post(state.needsBootstrap ? '/api/auth/register' : '/api/auth/login', { data: { email, password } });
  expect(response.ok()).toBeTruthy();
}

// The same account is reused only inside this isolated database; no local
// demo account, production session or fixture storage is touched.
test('guest locale follows the browser and unsupported languages fall back', async ({ browser, baseURL }) => {
  for (const [locale, expected] of [['en-US', 'en'], ['pt-PT', 'pt-BR'], ['ja-JP', 'ja'], ['nl-NL', 'ru']]) {
    const context = await browser.newContext({ locale, baseURL });
    const page = await context.newPage();
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', expected);
    const text = await page.locator('#auth-title').textContent();
    if (expected !== 'ru') expect(text).not.toMatch(/[А-Яа-яЁё]/);
    await context.close();
  }
});

test('language choice persists and switching preserves capture and setting drafts', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await page.locator('#capture-form [contenteditable="true"]').fill('Сегодня <script> alert(1) </script> **мой текст**');
  await page.evaluate(() => { location.hash = '#settings'; });
  const draft = page.locator('#capture-form [contenteditable="true"]');
  const original = await draft.innerText();
  await page.locator('#setting-googleClientId').evaluate(input => { input.value = 'America/Toronto'; });
  await page.locator('#setting-locale').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(draft).toHaveText(original);
  await expect(page.locator('#setting-googleClientId')).toHaveValue('America/Toronto');
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.locale).toBe('en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#setting-locale')).toHaveValue('en');
});

test('seven locales cover main routes, daily brief and mobile without JS errors', async ({ page }, testInfo) => {
  await login(page);
  // Editable persisted column names are user data, including the original
  // Russian seed; a Latin custom name separates them from built-in chrome.
  const board = await (await page.request.get('/api/board')).json();
  for (const column of board.columns) await page.request.patch(`/api/board/columns/${column.id}`, { data: { name: 'Personal tasks' } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#settings');
  for (const locale of ['ru', 'en', 'es', 'pt-BR', 'de', 'fr', 'ja']) {
    await page.locator('#setting-locale').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.locale).toBe(locale);
    await page.setViewportSize({ width: locale === 'ru' ? 1440 : 390, height: 844 });
    await page.goto('/#guide');
    await expect(page.locator('#guide')).toBeVisible();
    if (locale !== 'ru') {
      expect(await page.locator('#guide').innerText()).not.toMatch(/[А-Яа-яЁё]/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${locale} guide mobile overflow`).toBeLessThanOrEqual(1);
    }
    await page.goto('/#board');
    await expect(page.locator('#board')).toBeVisible();
    if (locale !== 'ru') {
      await expect.poll(() => page.locator('#board').innerText()).not.toMatch(/[А-Яа-яЁё]/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${locale} board mobile overflow`).toBeLessThanOrEqual(1);
    }
    for (const route of ['today', 'calendar', 'notes', 'brief']) {
      await page.goto('/#' + route);
      await expect(page.locator('#' + route)).toBeVisible();
      if (route === 'brief') {
        await expect(page.locator('.daily-brief-section h3')).toHaveCount(5);
        await expect(page.locator('.daily-brief-section .empty')).toHaveCount(5);
      }
      if (locale !== 'ru') {
        await expect.poll(() => page.locator('#' + route).innerText()).not.toMatch(/[А-Яа-яЁё]/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${locale} ${route} mobile overflow`).toBeLessThanOrEqual(1);
      }
    }
    await page.goto('/#settings');
    await expect(page.locator('#settings')).toBeVisible();
    if (locale !== 'ru') {
      await expect.poll(() => page.locator('#account-summary-line').innerText()).not.toMatch(/[А-Яа-яЁё]/);
      await expect.poll(() => page.locator('#telegram-state').innerText()).not.toMatch(/[А-Яа-яЁё]/);
      await expect.poll(() => page.locator('#notify-table').innerText()).not.toMatch(/[А-Яа-яЁё]/);
      await expect.poll(async () => (await page.locator('#avatar-presets button').evaluateAll(buttons => buttons.map(button => button.title))).join(' ')).not.toMatch(/[А-Яа-яЁё]/);
      expect(await page.locator('#settings [data-i18n]').allTextContents()).not.toEqual(expect.arrayContaining(['Настройки', 'Язык приложения']));
    }
    if (locale !== 'ru') expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (['en', 'ja'].includes(locale)) {
      const path = testInfo.outputPath(`settings-${locale}-mobile.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`settings-${locale}-mobile`, { path, contentType: 'image/png' });
    }
  }
  expect(errors).toEqual([]);
});

test('user Markdown and Cyrillic text remain untouched while editor defaults and dates localize', async ({ page }) => {
  await login(page);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { setLocale } = await import('/public/browser-i18n.js');
    const { renderMarkdown } = await import('/public/markdown.js');
    const { longDate, plural, MEETINGS } = await import('/public/today-cover.js');
    const { INLINE_MARKS } = await import('/public/format-toolbar.js');
    setLocale('en');
    return { html: renderMarkdown('Сегодня **личный текст** <script>alert(1)</script>'), identical: renderMarkdown('Настройки'), date: longDate('2026-10-02'), counts: [plural(1, MEETINGS), plural(2, MEETINGS)], label: INLINE_MARKS.bold.title };
  });
  expect(result.html).toContain('Сегодня');
  expect(result.identical).toContain('Настройки');
  expect(result.html).toContain('<strong>личный текст</strong>');
  expect(result.html).toContain('&lt;script&gt;');
  expect(result.html).not.toContain('<script>');
  expect(result.date).toMatch(/October/);
  expect(result.counts).toEqual(['1 meeting', '2 meetings']);
  expect(result.label).not.toMatch(/[А-Яа-яЁё]/);
});

test('committed locale event waits for success, includes same-language mode changes and excludes failures', async ({ page }) => {
  await login(page);
  await page.request.put('/api/settings', { data: { locale: 'system', detectedLocale: 'ru' } });
  await page.goto('/#settings');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.evaluate(() => {
    window.localeSaves = [];
    window.addEventListener('pagent:localesaved', event => window.localeSaves.push(event.detail));
  });
  let releaseWrite;
  const holdWrite = new Promise(resolve => { releaseWrite = resolve; });
  let writeHeld = false;
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT' && route.request().postDataJSON()?.locale === 'en') {
      writeHeld = true;
      await holdWrite;
      await route.fulfill({ response: await route.fetch() });
    } else await route.continue();
  });
  await page.locator('#setting-locale').selectOption('en');
  await expect.poll(() => writeHeld).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.evaluate(() => window.localeSaves)).toEqual([]);
  expect((await (await page.request.get('/api/settings')).json()).settings.locale).toBe('system');
  releaseWrite();
  await expect.poll(() => page.evaluate(() => window.localeSaves.length)).toBe(1);
  expect(await page.evaluate(() => window.localeSaves[0])).toMatchObject({ locale: 'en', requestedLocale: 'en' });
  await page.unroute('**/api/settings');

  await page.locator('#setting-locale').selectOption('system');
  await expect.poll(() => page.evaluate(() => window.localeSaves.length)).toBe(2);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.locator('#setting-locale').selectOption('ru');
  await expect.poll(() => page.evaluate(() => window.localeSaves.length)).toBe(3);
  expect(await page.evaluate(() => window.localeSaves[2])).toMatchObject({ locale: 'ru', requestedLocale: 'ru' });

  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT' && route.request().postDataJSON()?.locale === 'ja') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unavailable' } }) });
    } else await route.continue();
  });
  await page.locator('#setting-locale').selectOption('ja');
  await expect(page.locator('#setting-locale')).toHaveValue('ru');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  expect(await page.evaluate(() => window.localeSaves.length)).toBe(3);
});

test('account locale arriving after browser initialization updates module data and subsequent switches', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'en-US', baseURL });
  const page = await context.newPage();
  try {
    await login(page);
    await page.request.put('/api/settings', { data: { locale: 'ja' } });
    let releaseSettings;
    const delayedSettings = new Promise(resolve => { releaseSettings = resolve; });
    let settingsHeld = false;
    await page.route('**/api/settings', async route => {
      if (route.request().method() === 'GET') {
        settingsHeld = true;
        await delayedSettings;
      }
      await route.continue();
    });
    await page.goto('/#notes');
    await expect.poll(() => settingsHeld).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    releaseSettings();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await page.unroute('**/api/settings');
    // The already-open notes view updates when account settings arrive.
    const readExpectations = locale => page.evaluate(async locale => {
      const { translate } = await import('/public/i18n.js');
      const { WEEKDAYS, WEEKDAYS_SHORT, MONTHS } = await import('/public/today-cover.js');
      return {
        dates: [WEEKDAYS[1], WEEKDAYS_SHORT[1], MONTHS[9]],
        expectedDates: ['Понедельник', 'пн', 'октября'].map(source => translate(locale, source)),
        layouts: ['Таблица', 'Галерея', 'Список'].map(source => translate(locale, source)),
        sorts: ['Сначала новые', 'Недавно изменённые', 'По названию'].map(source => translate(locale, source)),
      };
    }, locale);
    const japanese = await readExpectations('ja');
    expect(japanese.dates).toEqual(japanese.expectedDates);
    await expect(page.locator('.notes-base-tabs button')).toHaveText(japanese.layouts);
    await expect(page.locator('.notes-base-controls select:has(option[value="created"])').locator('option')).toHaveText(japanese.sorts);
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.locator('#setting-locale').selectOption('de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.locale).toBe('de');
    await page.evaluate(() => { location.hash = '#notes'; });
    const german = await readExpectations('de');
    expect(german.dates).toEqual(german.expectedDates);
    await expect(page.locator('.notes-base-tabs button')).toHaveText(german.layouts);
  } finally { await context.close(); }
});


test('guest and next session ignore a previous account locale in shared browser storage', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'ru-RU', baseURL });
  const page = await context.newPage();
  try {
    await login(page);
    await page.request.put('/api/settings', { data: { locale: 'ja' } });
    await page.goto('/#settings');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await page.evaluate(() => localStorage.setItem('pagent.locale', 'ja'));
    await context.clearCookies();
    for (const route of ['/login', '/', '/public/mac-download.html']) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    }
    // Same browser storage, new authenticated session with its own preference.
    await login(page);
    await page.request.put('/api/settings', { data: { locale: 'de' } });
    await page.goto('/#settings');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('#setting-locale')).toHaveValue('de');
  } finally { await context.close(); }
});


test('unsupported browser languages retain stored detection while supported browser languages update it', async ({ browser, baseURL }) => {
  for (const [browserLocale, expectedLocale] of [['nl-NL', 'en'], ['ja-JP', 'ja']]) {
    const context = await browser.newContext({ locale: browserLocale, baseURL });
    const page = await context.newPage();
    try {
      await login(page);
      await page.request.put('/api/settings', { data: { locale: 'system', detectedLocale: 'en' } });
      await page.goto('/#settings');
      await expect(page.locator('html')).toHaveAttribute('lang', expectedLocale);
      await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.detectedLocale).toBe(expectedLocale);
      const detected = await page.evaluate(async () => (await import('/public/browser-i18n.js')).getDetectedLocale('en'));
      expect(detected).toBe(expectedLocale);
      await page.locator('#setting-locale').selectOption('fr');
      await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.locale).toBe('fr');
      expect((await (await page.request.get('/api/settings')).json()).settings.detectedLocale).toBe(expectedLocale);
    } finally { await context.close(); }
  }
});

test('daily brief localizes only known presentation fields and preserves historical generated Markdown', async ({ page }) => {
  await login(page);
  await page.request.put('/api/settings', { data: { locale: 'en' } });
  await page.route('**/api/daily-brief', async route => {
    const response = await route.fetch();
    const brief = await response.json();
    brief.content.sections.find(section => section.key === 'doneYesterday').items = [
      { key: 'historical-user-text', text: '**Сделано вчера** <script>alert(1)</script>' },
    ];
    await route.fulfill({ response, json: brief });
  });
  await page.goto('/#brief');
  await expect(page.locator('.daily-brief-section h3')).toHaveCount(5);
  const expectations = await page.evaluate(async () => {
    const { translate } = await import('/public/i18n.js');
    const { DAILY_BRIEF_PRESENTATION_SOURCES } = await import('/public/daily-brief.js');
    return Object.values(DAILY_BRIEF_PRESENTATION_SOURCES).map(section => translate('en', section.label));
  });
  await expect(page.locator('.daily-brief-section h3')).toHaveText(expectations);
  const historical = page.locator('.daily-brief-section .entry-title');
  await expect(historical).toHaveText('Сделано вчера <script>alert(1)</script>');
  await expect(historical.locator('strong')).toHaveText('Сделано вчера');
  await expect(historical.locator('script')).toHaveCount(0);
});

for (const olderWriteFails of [false, true]) {
  test(`rapid locale selections serialize writes and ignore stale ${olderWriteFails ? 'failures' : 'successes'}`, async ({ page }) => {
    await login(page);
    await page.request.put('/api/settings', { data: { locale: 'ru' } });
    await page.goto('/#settings');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await page.evaluate(() => {
      window.localeSaves = [];
      window.addEventListener('pagent:localesaved', event => window.localeSaves.push(event.detail));
    });
    let releaseOlder;
    const olderHeld = new Promise(resolve => { releaseOlder = resolve; });
    const writes = [];
    await page.route('**/api/settings', async route => {
      const choice = route.request().method() === 'PUT' && route.request().postDataJSON()?.locale;
      if (!choice) return route.continue();
      writes.push(choice);
      if (choice === 'de') {
        await olderHeld;
        if (olderWriteFails) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unavailable' } }) });
      }
      await route.fulfill({ response: await route.fetch() });
    });
    await page.locator('#setting-locale').selectOption('de');
    await expect.poll(() => writes.length).toBe(1);
    await page.locator('#setting-locale').selectOption('ja');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    expect(writes).toEqual(['de']);
    expect(await page.evaluate(() => window.localeSaves)).toEqual([]);
    releaseOlder();
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.locale).toBe('ja');
    await expect.poll(() => page.evaluate(() => window.localeSaves.length)).toBe(1);
    expect(writes).toEqual(['de', 'ja']);
    await expect(page.locator('#setting-locale')).toHaveValue('ja');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    expect(await page.evaluate(() => window.localeSaves[0].requestedLocale)).toBe('ja');
  });
}

test('locale responses preserve drafts edited during the request and concurrent autosaves cannot restore an older locale', async ({ page }) => {
  await login(page);
  await page.request.put('/api/settings', { data: { locale: 'ru' } });
  await page.goto('/#settings');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.evaluate(() => { window.localeSaved = false; window.addEventListener('pagent:localesaved', () => { window.localeSaved = true; }); });
  await page.locator('#setting-googleClientId').evaluate(input => { input.value = 'America/Toronto'; });
  let releaseLocale, releaseField;
  const localeHeld = new Promise(resolve => { releaseLocale = resolve; });
  const fieldHeld = new Promise(resolve => { releaseField = resolve; });
  let localeStarted = false, fieldStarted = false, fieldCompleted = false;
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const patch = route.request().postDataJSON();
    if (patch.locale === 'en') {
      localeStarted = true;
      await localeHeld;
    } else if (patch.googleClientId) {
      const response = await route.fetch();
      fieldStarted = true;
      await fieldHeld;
      await route.fulfill({ response });
      fieldCompleted = true;
      return;
    }
    await route.fulfill({ response: await route.fetch() });
  });
  await page.locator('#setting-locale').selectOption('en');
  await expect.poll(() => localeStarted).toBe(true);
  await page.locator('#setting-googleClientId').fill('America/Vancouver');
  await page.locator('#setting-openaiKey').fill('new-secret-draft-entered-during-locale-save');
  await expect.poll(() => fieldStarted).toBe(true);
  // A further unsubmitted edit must survive the earlier field response too.
  await page.locator('#setting-googleClientId').evaluate(input => { input.value = 'America/Edmonton'; });
  releaseLocale();
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.locale).toBe('en');
  await expect.poll(() => page.evaluate(() => window.localeSaved)).toBe(true);
  await expect(page.locator('#setting-googleClientId')).toHaveValue('America/Edmonton');
  await expect(page.locator('#setting-openaiKey')).toHaveValue('new-secret-draft-entered-during-locale-save');
  releaseField();
  await expect.poll(() => fieldCompleted).toBe(true);
  await expect(page.locator('#settings-status')).not.toHaveText('Saving…');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#setting-locale')).toHaveValue('en');
  await expect(page.locator('#setting-googleClientId')).toHaveValue('America/Edmonton');
  await expect(page.locator('#setting-openaiKey')).toHaveValue('new-secret-draft-entered-during-locale-save');
});


test('personal timezone follows browser/native detection, preserves manual choice and account isolation', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York', baseURL });
  const page = await context.newPage();
  try {
    await login(page);
    const original = (await (await page.request.get('/api/settings')).json()).settings.timeZone;
    await page.request.put('/api/settings', { data: { locale: 'en', requestedTimeZone: 'system', detectedTimeZone: 'UTC' } });
    await page.goto('/#settings');
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.detectedTimeZone).toBe('America/New_York');
    await expect(page.locator('#setting-effectiveTimeZone')).toHaveText('America/New_York');
    await page.locator('#setting-requestedTimeZone').selectOption('Europe/Berlin');
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).timeZone).toBe('Europe/Berlin');
    await page.reload();
    await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('Europe/Berlin');
    await page.evaluate(() => { window.KizunaSystemTimeZone = 'Asia/Tokyo'; window.dispatchEvent(new CustomEvent('pagent:systemtimezonechange')); });
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.detectedTimeZone).toBe('Asia/Tokyo');
    await expect(page.locator('#setting-effectiveTimeZone')).toHaveText('Europe/Berlin');
    await page.locator('#setting-requestedTimeZone').selectOption('system');
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).timeZone).toBe('Asia/Tokyo');
    await expect(page.locator('#setting-effectiveTimeZone')).toHaveText('Asia/Tokyo');
    // A second account in the same browser must initialize from its own
    // preference and the device, never the previous account's manual choice.
    const secondEmail = 'timezone-second@kizuna.test';
    const registration = await page.request.post('/api/auth/register', { data: { email: secondEmail, password } });
    expect(registration.status()).toBe(201);
    const users = await (await page.request.get('/api/admin/users')).json();
    const second = users.users.find(user => user.email === secondEmail);
    expect(second).toBeTruthy();
    expect((await page.request.post(`/api/admin/users/${second.id}/approve`, { data: {} })).ok()).toBeTruthy();
    await page.locator('#setting-requestedTimeZone').selectOption('Europe/Berlin');
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).timeZone).toBe('Europe/Berlin');
    await context.clearCookies();
    await page.goto('/login');
    expect((await page.request.post('/api/auth/login', { data: { email: secondEmail, password } })).ok()).toBeTruthy();
    await page.goto('/#settings');
    await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('system');
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).timeZone).toBe('America/New_York');
    await context.clearCookies();
    await page.goto('/login');
    await login(page);
    await page.goto('/#settings');
    await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('Europe/Berlin');
    expect((await (await page.request.get('/api/settings')).json()).settings.timeZone).toBe(original);
  } finally { await context.close(); }
});

for (const olderWriteFails of [false, true]) {
  test(`rapid personal timezone selections serialize and ignore stale ${olderWriteFails ? 'failure' : 'success'}`, async ({ page }) => {
    await login(page);
    await page.request.put('/api/settings', { data: { requestedTimeZone: 'UTC' } });
    await page.goto('/#settings');
    await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('UTC');
    await page.evaluate(() => { window.timeZoneSaves = []; window.addEventListener('pagent:timezonesaved', event => window.timeZoneSaves.push(event.detail)); });
    let releaseOlder;
    const held = new Promise(resolve => { releaseOlder = resolve; });
    const writes = [];
    await page.route('**/api/settings', async route => {
      const choice = route.request().method() === 'PUT' && route.request().postDataJSON()?.requestedTimeZone;
      if (!choice) return route.continue();
      writes.push(choice);
      if (choice === 'Asia/Tokyo') {
        await held;
        if (olderWriteFails) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unavailable' } }) });
      }
      await route.fulfill({ response: await route.fetch() });
    });
    await page.locator('#setting-requestedTimeZone').selectOption('Asia/Tokyo');
    await expect.poll(() => writes.length).toBe(1);
    await page.locator('#setting-requestedTimeZone').selectOption('America/New_York');
    await expect(page.locator('#setting-effectiveTimeZone')).toHaveText('America/New_York');
    expect(writes).toEqual(['Asia/Tokyo']);
    releaseOlder();
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).timeZone).toBe('America/New_York');
    await expect.poll(() => page.evaluate(() => window.timeZoneSaves.length)).toBe(1);
    expect(await page.evaluate(() => window.timeZoneSaves[0])).toMatchObject({ timeZone: 'America/New_York', requestedTimeZone: 'America/New_York' });
    await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('America/New_York');
    const dates = await page.evaluate(async () => {
      const { getTimeZone } = await import('/public/browser-time-zone.js');
      const { longDate } = await import('/public/today-cover.js');
      const time = at => new Intl.DateTimeFormat('en-GB', { timeZone: getTimeZone(), hour: '2-digit', minute: '2-digit' }).format(new Date(at));
      return { before: time('2026-03-08T06:30:00Z'), after: time('2026-03-08T07:30:00Z'), dateOnly: longDate('2026-03-08') };
    });
    expect(dates).toMatchObject({ before: '01:30', after: '03:30' });
    expect(dates.dateOnly).toContain('8');
  });
}

test('a manual timezone selection and draft survive a delayed locale response', async ({ page }) => {
  await login(page);
  await page.request.put('/api/settings', { data: { locale: 'ru', requestedTimeZone: 'UTC' } });
  await page.goto('/#settings');
  await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('UTC');
  let releaseLocale;
  const held = new Promise(resolve => { releaseLocale = resolve; });
  let localeStarted = false;
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT' && route.request().postDataJSON()?.locale === 'en') {
      localeStarted = true;
      await held;
      return route.fulfill({ response: await route.fetch() });
    }
    return route.continue();
  });
  await page.locator('#setting-locale').selectOption('en');
  await expect.poll(() => localeStarted).toBe(true);
  await page.locator('#setting-requestedTimeZone').selectOption('Asia/Tokyo');
  await page.locator('#setting-googleClientId').fill('timezone-and-language-draft');
  await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('Asia/Tokyo');
  releaseLocale();
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).timeZone).toBe('Asia/Tokyo');
  await expect(page.locator('#setting-locale')).toHaveValue('en');
  await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('Asia/Tokyo');
  await expect(page.locator('#setting-googleClientId')).toHaveValue('timezone-and-language-draft');
});


test('initial device detection is serialized before newer manual timezone and locale choices', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York', baseURL });
  const page = await context.newPage();
  try {
    await login(page);
    await page.request.put('/api/settings', { data: { locale: 'en', requestedTimeZone: 'system', detectedTimeZone: 'UTC' } });
    let releaseDetection;
    const held = new Promise(resolve => { releaseDetection = resolve; });
    const writes = [];
    await page.route('**/api/settings', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      const patch = route.request().postDataJSON();
      const kind = patch.requestedTimeZone || patch.locale || 'detection';
      writes.push(kind);
      const response = await route.fetch();
      if (kind === 'detection') await held;
      await route.fulfill({ response });
    });
    await page.goto('/#settings');
    await expect.poll(() => writes).toEqual(['detection']);
    await page.locator('#setting-requestedTimeZone').selectOption('Europe/Berlin');
    await page.locator('#setting-locale').selectOption('ja');
    await page.locator('#setting-googleClientId').fill('initial-detection-draft');
    await expect(page.locator('#setting-effectiveTimeZone')).toHaveText('Europe/Berlin');
    expect(writes).toEqual(['detection']);
    releaseDetection();
    await expect.poll(async () => { const payload = await (await page.request.get('/api/settings')).json(); return [payload.timeZone, payload.settings.locale]; }).toEqual(['Europe/Berlin', 'ja']);
    expect(writes).toEqual(['detection', 'Europe/Berlin', 'ja']);
    await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('Europe/Berlin');
    await expect(page.locator('#setting-effectiveTimeZone')).toHaveText('Europe/Berlin');
    await expect(page.locator('#setting-googleClientId')).toHaveValue('initial-detection-draft');
    expect(await page.evaluate(async () => (await import('/public/browser-time-zone.js')).getTimeZone())).toBe('Europe/Berlin');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  } finally { await context.close(); }
});

test('a delayed settings GET preserves subsequently committed preferences and new drafts', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York', baseURL });
  const page = await context.newPage();
  try {
    await login(page);
    await page.request.put('/api/settings', { data: { locale: 'en', requestedTimeZone: 'system', detectedTimeZone: 'America/New_York' } });
    await page.goto('/#settings');
    await expect(page.locator('#setting-effectiveTimeZone')).toHaveText('America/New_York');
    let releaseGet;
    const held = new Promise(resolve => { releaseGet = resolve; });
    let getHeld = false;
    await page.route('**/api/settings', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      getHeld = true;
      await held;
      await route.fulfill({ response });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => getHeld).toBe(true);
    await page.locator('#setting-requestedTimeZone').selectOption('Europe/Berlin');
    await page.locator('#setting-locale').selectOption('ja');
    await expect.poll(async () => { const payload = await (await page.request.get('/api/settings')).json(); return [payload.timeZone, payload.settings.locale]; }).toEqual(['Europe/Berlin', 'ja']);
    await page.locator('#setting-openaiKey').fill('new-draft-while-get-pending');
    const received = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'GET');
    releaseGet();
    await received;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#setting-requestedTimeZone')).toHaveValue('Europe/Berlin');
    await expect(page.locator('#setting-effectiveTimeZone')).toHaveText('Europe/Berlin');
    await expect(page.locator('#setting-locale')).toHaveValue('ja');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.locator('#setting-openaiKey')).toHaveValue('new-draft-while-get-pending');
    expect(await page.evaluate(async () => (await import('/public/browser-time-zone.js')).getTimeZone())).toBe('Europe/Berlin');
  } finally { await context.close(); }
});
