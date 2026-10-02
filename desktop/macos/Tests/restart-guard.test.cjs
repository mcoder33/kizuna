const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('@playwright/test');

test('protect drafts and in-flight writes, then lock editing for installation', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript({ path: path.join(__dirname, '../Resources/RestartGuard.js') });
    await page.route('https://kizuna.test/', route => route.fulfill({ contentType: 'text/html', body:
      '<div id="capture-input" contenteditable="true"></div><input id="title" value="Existing title"><textarea id="message"></textarea><button id="action">Save</button>' }));
    const prepare = () => page.evaluate(() => window.KizunaUpdateGuard.prepare());
    const resume = () => page.evaluate(() => window.KizunaUpdateGuard.resume());
    await page.goto('https://kizuna.test/');
    assert.equal(await prepare(), null);
    await resume();
    await page.locator('#capture-input').fill('Do not lose this draft');
    assert.match(await prepare(), /Сохраните/);
    await page.locator('#capture-input').fill('');
    assert.equal(await prepare(), null);
    await resume();
    await page.locator('#title').fill('Changed title');
    assert.match(await prepare(), /редактирование/);
    await page.locator('#title').fill('Existing title');
    assert.equal(await prepare(), null);
    await resume();
    await page.locator('#message').fill('Unsent comment');
    assert.match(await prepare(), /Сохраните/);
    await page.locator('#message').fill('');

    let finishWrite;
    await page.route('https://kizuna.test/save', route => new Promise(resolve => {
      finishWrite = async () => { await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); resolve(); };
    }));
    await page.evaluate(() => { window.saving = fetch('/save', { method: 'POST' }).then(r => r.json()); });
    await page.waitForFunction(() => Boolean(window.saving));
    assert.match(await prepare(), /Дождитесь сохранения/);
    while (!finishWrite) await new Promise(resolve => setTimeout(resolve, 10));
    await finishWrite();
    await page.evaluate(() => window.saving);
    await page.waitForFunction(() => window.KizunaUpdateGuard.prepare() === null);
    await resume();

    // Restoring a draft programmatically must also block a restart.
    await page.evaluate(() => { document.querySelector('#capture-input').textContent = 'Restored draft'; });
    assert.match(await prepare(), /Сохраните/);
    await page.evaluate(() => { document.querySelector('#capture-input').textContent = ''; });
    assert.equal(await prepare(), null);
    await page.locator('#capture-input').focus();
    await page.keyboard.type('must not enter during restart');
    assert.equal(await page.locator('#capture-input').textContent(), '');
    await resume();
    await page.keyboard.type('editing works again');
    assert.equal(await page.locator('#capture-input').textContent(), 'editing works again');
    await page.locator('#capture-input').fill('');
    await page.evaluate(() => {
      window.chatDraft = 'Hidden conversation draft';
      window.addEventListener('kizuna:before-update', event => {
        if (window.chatDraft) event.detail.block('Сохраните черновик разговора.');
        if (window.noteSaved) event.detail.savedEditors.push(document.querySelector('#title'));
      });
    });
    assert.match(await prepare(), /черновик разговора/);
    await page.evaluate(() => { window.chatDraft = ''; });
    await page.locator('#title').fill('Autosaved note');
    assert.match(await prepare(), /редактирование/);
    await page.evaluate(() => { window.noteSaved = true; });
    assert.equal(await prepare(), null);
  } finally { await browser.close(); }
});
