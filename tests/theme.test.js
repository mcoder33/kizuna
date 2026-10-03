import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
function fixture(saved = null, { unavailable = false, account = null } = {}) {
  const values = new Map(saved === null ? [] : [['pagent.theme', saved]]), attributes = new Map();
  const root = { dataset: account ? { accountId: 'alice', uiPreferences: encodeURIComponent(JSON.stringify({ userId: 'alice', values: { 'pagent.theme': account } })) } : {},
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) };
  const events = [], storage = { getItem: key => { if (unavailable) throw Error('blocked'); return values.get(key) ?? null; }, setItem: (key, value) => values.set(key, value) };
  const window = { dispatchEvent: event => events.push(event) };
  vm.runInNewContext(script, { window, document: { documentElement: root }, localStorage: storage, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  return { theme: window.pagentTheme, attributes, values, events, window };
}

test('auto is the default without a choice, including unavailable storage; explicit choices survive', () => {
  for (const f of [fixture(), fixture(null, { unavailable: true }), fixture('system')]) {
    assert.equal(f.theme.read(), 'system'); assert.equal(f.attributes.has('data-theme'), false);
  }
  for (const choice of ['light', 'dark']) {
    const f = fixture(choice); assert.equal(f.theme.read(), choice); assert.equal(f.attributes.get('data-theme'), choice);
  }
});

test('toggle returns to auto, persists the mode and restores it before rendering', () => {
  const f = fixture();
  for (const choice of ['light', 'dark', 'system']) {
    assert.equal(f.theme.next(), choice); f.theme.set(choice);
    assert.equal(f.values.get('pagent.theme'), choice); assert.equal(f.events.at(-1).detail.theme, choice);
  }
  assert.equal(f.attributes.has('data-theme'), false);
  assert.equal(f.theme.hasChoice(), true);
  const fresh = fixture('dark', { account: 'system' });
  assert.equal(fresh.theme.read(), 'system'); assert.equal(fresh.attributes.has('data-theme'), false);
  fresh.window.pagentPreferenceStorage = { getItem: () => 'light' }; fresh.theme.refresh();
  assert.equal(fresh.attributes.get('data-theme'), 'light');
});
