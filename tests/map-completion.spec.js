import { test, expect, setUiPreferences } from './fixtures/ui-preferences.js';

for (const width of [1440, 960, 768, 375]) {
  test.describe(`map completion at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width === 375, hasTouch: width === 375 });

    test('a branch can be completed and reopened independently of its children', async ({ page, request }, testInfo) => {
      const root = (await (await request.post('/api/captures', { data: { raw: 'Map completion root', primaryType: 'todo' } })).json()).entry;
      const sub = async (parent, title) => (await (await request.post(`/api/captures/${parent.id}/subtasks`, { data: { title } })).json()).entry;
      const branch = await sub(root, 'ываыв');
      const completed = await sub(branch, 'Completed child');
      const pending = await sub(branch, 'Pending child');
      await request.post(`/api/projections/${completed.projections[0].id}/complete`, { data: {} });

      await page.goto(`/#today?open=${root.id}`);
      const dialog = page.locator('#review-dialog');
      await expect(dialog.locator('.card-title')).toHaveText('Map completion root');
      await dialog.getByRole('button', { name: 'Карта', exact: true }).click();
      const row = dialog.locator(`[data-tree-id="${branch.id}"]`);
      const dial = row.locator('.branch-dial');
      const check = row.getByRole('checkbox', { name: 'Выполнить шаг: ываыв', exact: true });
      await expect(check).toBeVisible();
      await expect(check).not.toBeChecked();
      await expect(dial).toHaveAttribute('aria-label', '1 из 2 шагов');
      expect((await row.boundingBox()).height).toBeLessThan(45);

      // The original ring is clickable, including its edge outside the checkbox.
      await dial.click({ position: { x: 2, y: 14 } });
      await expect(check).toBeChecked();
      await expect(check).toBeEnabled();
      await expect(row.locator('.tree-title')).toHaveClass(/done/);
      await expect(dialog.locator('.card-title')).toHaveText('Map completion root');
      await page.reload();
      await page.goto(`/#today?open=${root.id}`);
      await expect(dialog.locator('.card-title')).toHaveText('Map completion root');
      await dialog.getByRole('button', { name: 'Карта', exact: true }).click();
      await expect(check).toBeChecked();
      await expect(dial).toHaveAttribute('aria-label', '1 из 2 шагов');
      await expect(dialog.locator(`[data-tree-id="${completed.id}"] .tree-check`)).toBeChecked();
      await expect(dialog.locator(`[data-tree-id="${pending.id}"] .tree-check`)).not.toBeChecked();
      await expect(dialog.locator('.completion-halo .card-tick')).toHaveAttribute('aria-pressed', 'false');
      await expect(dialog.locator('.subtask-count')).toHaveText('1 / 2');
      await expect.poll(() => dialog.locator('#card-subtasks').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`map-${width}-completed.png`) });
      if (width === 1440 || width === 375) {
        await setUiPreferences(request, { 'pagent.theme': 'dark' });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await page.screenshot({ path: testInfo.outputPath(`map-${width}-dark.png`) });
      }

      // Keyboard completion uses the same control and preserves child progress.
      await check.focus();
      await page.keyboard.press('Space');
      await expect(check).not.toBeChecked();
      await expect(check).toBeEnabled();
      await expect(row.locator('.tree-title')).not.toHaveClass(/done/);
      await expect(dial).toHaveAttribute('aria-label', '1 из 2 шагов');
      const tree = (await (await request.get(`/api/captures/${root.id}/subtasks`)).json());
      expect(tree.nodes.find(node => node.id === branch.id).done).toBe(false);
      expect(tree.nodes.find(node => node.id === completed.id).done).toBe(true);
      expect(tree.nodes.find(node => node.id === pending.id).done).toBe(false);

      await row.locator('.tree-fold').click();
      await expect(dialog.locator(`[data-tree-id="${pending.id}"]`)).toHaveCount(0);
      await expect(check).toBeVisible();
      await row.locator('.tree-open').click();
      await expect(dialog.locator('.card-title')).toHaveText('ываыв');
    });
  });
}
