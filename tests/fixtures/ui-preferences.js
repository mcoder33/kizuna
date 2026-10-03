import { test as base, expect } from '@playwright/test';
import { UI_PREFERENCE_KEYS } from '../../public/ui-preference-schema.js';

export async function setUiPreferences(request, changes) {
  const { userId } = await (await request.get('/api/ui-preferences')).json();
  expect((await request.patch('/api/ui-preferences', { data: { userId, changes } })).ok()).toBe(true);
}

// Display choices now belong to the shared test account, not each test's new
// browser context. Give existing UI scenarios the same isolated defaults.
export const test = base.extend({
  accountViewDefaults: [async ({ request }, use) => {
    const defaults = { ...Object.fromEntries(UI_PREFERENCE_KEYS.map(key => [key, null])), 'kizuna-board-filter': '[]' };
    await setUiPreferences(request, defaults);
    await use();
    await setUiPreferences(request, defaults);
  }, { auto: true }],
});
export { expect };
