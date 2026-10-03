import test from 'node:test';
import assert from 'node:assert/strict';
import { sendTelegramReport } from '../server/telegram-report-message.js';

const image = { bytes: Buffer.from('image'), type: 'image/png', filename: 'report.png' };
const entities = [{ type: 'bold', offset: 3, length: 7 }];

test('short report sends one photo with unchanged text/entities and no buttons', async () => {
  const calls = [];
  const result = await sendTelegramReport({ chatId: 123, text: '✅ Мой туду', entities, image,
    sendText: () => { throw Error('not needed'); }, sendPhoto: async (...args) => { calls.push(args); return { message_id: 5 }; } });
  assert.equal(result.message_id, 5); assert.equal(calls.length, 1);
  assert.equal(calls[0][2].caption, '✅ Мой туду'); assert.deepEqual(calls[0][2].caption_entities, entities);
  assert.equal(calls[0][2].reply_markup, undefined);
});

test('long report keeps complete task text/entities; failed quiet photo does not invalidate delivery', async () => {
  const text = '😀'.repeat(520), calls = [];
  const result = await sendTelegramReport({ chatId: 123, text, entities, image,
    sendText: async (...args) => { calls.push(['text', ...args]); return { message_id: 6 }; },
    sendPhoto: async (...args) => { calls.push(['photo', ...args]); throw Object.assign(Error('network'), { status: 429 }); } });
  assert.equal(result.message_id, 6); assert.equal(calls[0][2], text); assert.deepEqual(calls[0][3].entities, entities);
  assert.equal(calls[1][3].caption, undefined); assert.equal(calls[1][3].disable_notification, true);
});

test('definite photo rejection uses a fresh source snapshot, while ambiguous errors and 429 never resend as text', async () => {
  let sent = 0, refreshed = 0;
  const options = { chatId: 123, text: 'old private title', entities, image,
    refreshMessage: () => { refreshed++; return { text: 'fresh public title', entities: [] }; },
    sendText: async (_, text) => { sent++; assert.equal(text, 'fresh public title'); return { message_id: 7 }; } };
  assert.equal((await sendTelegramReport({ ...options, sendPhoto: async () => { throw Object.assign(Error('bad photo'), { status: 400 }); } })).message_id, 7);
  assert.equal(refreshed, 1); assert.equal(sent, 1);
  for (const status of [429, 403, 500, undefined]) {
    await assert.rejects(sendTelegramReport({ ...options, sendPhoto: async () => { throw Object.assign(Error('ambiguous'), { status }); } }));
  }
  assert.equal(refreshed, 1); assert.equal(sent, 1);
});

test('access is rechecked after sending text and before a 400 fallback', async () => {
  let allowed = true, photos = 0, textCalls = 0;
  await sendTelegramReport({ chatId: 123, text: 'x'.repeat(1025), entities, image, stillAllowed: () => allowed,
    sendText: async () => { allowed = false; textCalls++; return { message_id: 8 }; }, sendPhoto: async () => { photos++; } });
  assert.equal(textCalls, 1); assert.equal(photos, 0);
  allowed = true;
  await assert.rejects(sendTelegramReport({ chatId: 123, text: 'short', entities, image, stillAllowed: () => allowed,
    sendText: async () => { textCalls++; }, sendPhoto: async () => { allowed = false; throw Object.assign(Error('rejected'), { status: 400 }); } }));
  assert.equal(textCalls, 1);
});
