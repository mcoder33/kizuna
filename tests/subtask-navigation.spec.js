import { test, expect } from './fixtures/ui-preferences.js';

test('expanded branches and completed leaves open their own cards without changing completion', async ({ page, request }) => {
  const root = (await (await request.post('/api/captures', { data: { raw: 'Tree navigation root', primaryType: 'todo' } })).json()).entry;
  const step = async (parent, title) => (await (await request.post(`/api/captures/${parent.id}/subtasks`, { data: { title } })).json()).entry;
  const parent = await step(root, 'ываыв');
  const child = await step(parent, 'Completed nested child');
  await page.goto(`/#today?open=${root.id}`);
  const dialog = page.locator('#review-dialog');
  await expect(dialog.locator('.card-title')).toHaveText('Tree navigation root');
  await dialog.getByRole('button', { name: 'Карта', exact: true }).click();
  const parentRow = dialog.locator(`[data-tree-id="${parent.id}"]`);
  const childRow = dialog.locator(`[data-tree-id="${child.id}"]`);
  await childRow.locator('.tree-check').check();
  await expect(parentRow.locator('small')).toHaveText('1 / 1');
  await expect(childRow.locator('.tree-check')).toBeChecked();
  await parentRow.locator('.tree-fold').click();
  await expect(childRow).toHaveCount(0);
  await expect(dialog.locator('.card-title')).toHaveText('Tree navigation root');
  await parentRow.locator('.tree-fold').click();
  await expect(childRow.locator('.tree-check')).toBeChecked();
  // Saving an inline title must not rebuild the target between press/release.
  await dialog.locator('.card-title').click();
  await dialog.locator('.card-title-edit').fill('Renamed tree root');
  await parentRow.locator('.tree-title').scrollIntoViewIfNeeded();
  const hit = await parentRow.locator('.tree-title').boundingBox();
  await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect(dialog.locator('.card-title')).toHaveText('ываыв');
  expect((await (await request.get(`/api/captures/${root.id}`)).json()).entry.interpretation.classification.summary).toBe('Renamed tree root');
  await dialog.locator('.card-title').click();
  await dialog.locator('.card-title-edit').fill('Renamed branch');
  await dialog.locator(`[data-tree-id="${child.id}"] .tree-open`).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.locator('.card-title')).toHaveText('Completed nested child');
  expect((await (await request.get(`/api/captures/${parent.id}`)).json()).entry.interpretation.classification.summary).toBe('Renamed branch');
});

for (const [width, height] of [[1440, 900], [960, 900], [375, 812]]) {
  test.describe(`${width}px viewport`, () => {
  test.use({ isMobile: width === 375, hasTouch: width === 375 });
  test(`note and steps resize, persist and leave text usable at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    const me = (await (await request.get('/api/auth/state')).json()).user;
    await request.patch('/api/ui-preferences', { data: { userId: me.id, changes: { 'kizuna-card-mode': 'full', 'kizuna-card-note-share': null } } });
    const root = (await (await request.post('/api/captures', { data: { raw: 'Resizable work area', primaryType: 'todo' } })).json()).entry;
    const child = (await (await request.post(`/api/captures/${root.id}/subtasks`, { data: { title: 'Visible nested step' } })).json()).entry;
    await page.goto(`/#today?open=${root.id}`);
    const divider = page.getByRole('separator', { name: 'Размер заметки и подзадач' });
    await expect(divider).toBeVisible();
    const workspace = page.locator('.card-workspace');
    const fraction = () => workspace.evaluate(element => {
      const note = element.querySelector('.card-body').getBoundingClientRect().height;
      const steps = element.querySelector('.card-subtasks').getBoundingClientRect().height;
      return note / (note + steps);
    });
    const horizontalOverflow = () => workspace.locator('.card-subtasks').evaluate(element => element.scrollWidth - element.clientWidth);
    expect(await fraction()).toBeCloseTo(2 / 3, 1);
    expect(await horizontalOverflow()).toBeLessThanOrEqual(1);
    await settledScreenshot(page, { path: `/tmp/pagent-subtask-split-${width}-default.png` });
    const start = await divider.boundingBox();
    if (width === 375) {
      const touch = await page.context().newCDPSession(page);
      const point = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: start.y - 55 }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await touch.detach();
    } else {
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2, start.y - 55, { steps: 5 });
      await page.mouse.up();
    }
    await expect.poll(fraction).toBeLessThan(0.6);
    await expect.poll(horizontalOverflow).toBeLessThanOrEqual(1);
    await expect.poll(async () => (await (await request.get('/api/ui-preferences')).json()).values['kizuna-card-note-share']).not.toBeNull();
    const saved = await divider.getAttribute('aria-valuenow');
    await page.reload();
    // The app removes the open intent after mounting; reopening uses the saved preference.
    await page.goto(`/#today?open=${root.id}`);
    await expect(divider).toHaveAttribute('aria-valuenow', saved);
    const beforeTyping = await divider.getAttribute('aria-valuenow');
    await page.route(`**/api/captures/${root.id}/notes`, async route => {
      await new Promise(resolve => setTimeout(resolve, 300));
      await route.continue();
    });
    await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Keep this body through navigation');
    await expect(divider).toHaveAttribute('aria-valuenow', beforeTyping);
    await divider.focus();
    await page.keyboard.press('ArrowUp');
    await expect(divider).toHaveAttribute('aria-valuenow', String(Number(saved) - 5));
    await settledScreenshot(page, { path: `/tmp/pagent-subtask-split-${width}.png` });
    await page.locator(`#card-subtask-list [data-task-id="${child.id}"] .subtask-name`).click();
    await expect(page.locator('#review .card-title')).toHaveText('Visible nested step');
    expect((await (await request.get(`/api/captures/${root.id}`)).json()).entry.note.body).toBe('Keep this body through navigation');
    await expect(divider).toBeHidden();
    const dimensions = await workspace.evaluate(element => ({ workspace: element.clientHeight, note: element.querySelector('.card-body').getBoundingClientRect().height + (parseFloat(getComputedStyle(element.querySelector('.card-body')).marginTop) || 0) + (parseFloat(getComputedStyle(element.querySelector('.card-body')).marginBottom) || 0), emptySteps: element.querySelector('.card-subtasks').getBoundingClientRect().height + 10 }));
    expect(dimensions.note).toBeGreaterThanOrEqual(dimensions.workspace - dimensions.emptySteps - 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await settledScreenshot(page, { path: `/tmp/pagent-subtask-empty-${width}.png` });
  });
  });
}

test('split ratio syncs between own tabs without replacing text and isolates another account', async ({ page, context, browser, request }) => {
  const me = (await (await request.get('/api/auth/state')).json()).user;
  const makeTree = async api => {
    const root = (await (await api.post('/api/captures', { data: { raw: 'Split preference isolation', primaryType: 'todo' } })).json()).entry;
    await api.post(`/api/captures/${root.id}/subtasks`, { data: { title: 'An isolated child' } });
    return root;
  };
  const root = await makeTree(request);
  await page.goto(`/#today?open=${root.id}`);
  const second = await context.newPage();
  await second.goto(`/#today?open=${root.id}`);
  const divider = tab => tab.getByRole('separator', { name: 'Размер заметки и подзадач' });
  await expect(divider(second)).toBeVisible();
  const text = page.getByRole('textbox', { name: 'Описание', exact: true });
  await text.fill('Retain the active note across remote preference updates');
  await page.evaluate(() => { window.noteBeforeResize = document.querySelector('#card-body-editor'); });
  expect((await request.patch('/api/ui-preferences', { data: { userId: me.id, changes: { 'kizuna-card-note-share': '45' } } })).ok()).toBe(true);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', '45');
  await expect(divider(second)).toHaveAttribute('aria-valuenow', '45');
  await expect(text).toHaveText('Retain the active note across remote preference updates');
  expect(await page.evaluate(() => window.noteBeforeResize === document.querySelector('#card-body-editor'))).toBe(true);
  await second.close();
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: { cookies: [], origins: [] }, locale: 'ru-RU' });
  try {
    const signup = await other.request.post('/api/auth/register', { data: { email: `split-${Date.now()}@kizuna.test`, password: 'split-isolation-long-password' } });
    expect(signup.status()).toBe(201);
    const theirs = await makeTree(other.request);
    const otherPage = await other.newPage();
    await otherPage.goto(`/#today?open=${theirs.id}`);
    await expect(divider(otherPage)).toHaveAttribute('aria-valuenow', '67');
    expect((await (await other.request.get('/api/ui-preferences')).json()).values['kizuna-card-note-share']).toBeUndefined();
  } finally { await other.close(); }
});

async function settledScreenshot(page, options) {
  await page.locator('#review-dialog').evaluate(async element => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  });
  await page.screenshot(options);
}
