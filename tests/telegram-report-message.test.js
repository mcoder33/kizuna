import test from 'node:test';
import assert from 'node:assert/strict';
import { sendTelegramReport } from '../server/telegram-report-message.js';

const image = { bytes: Buffer.from('image'), type: 'image/png', filename: 'report.png' };
const entities = [{ type: 'bold', offset: 3, length: 7 }];
const base = { chatId: 123, text: '✅ Мой туду', entities, image, sleep: async () => {} };
const failure = status => Object.assign(Error('Bad Request: IMAGE_PROCESS_FAILED'), { status });

test('short report sends one photo with unchanged text/entities and no buttons', async () => {
  const calls = [];
  const result = await sendTelegramReport({ ...base,
    sendText: () => { throw Error('not needed'); }, sendPhoto: async (...args) => { calls.push(args); return { message_id: 5 }; } });
  assert.equal(result.message_id, 5); assert.equal(calls.length, 1);
  assert.equal(calls[0][2].caption, base.text); assert.deepEqual(calls[0][2].caption_entities, entities);
  assert.equal(calls[0][2].reply_markup, undefined);
});

test('photo may succeed on the tenth retry without failure logging or text fallback', async () => {
  let photos = 0; const pauses = [];
  const result = await sendTelegramReport({ ...base, sleep: async ms => pauses.push(ms),
    sendPhoto: async () => { if (++photos <= 10) throw failure(400); return { message_id: 6 }; },
    sendText: () => assert.fail('must not send text'), audit: () => assert.fail('must not log a final failure') });
  assert.equal(result.message_id, 6); assert.equal(photos, 11);
  assert.equal(pauses.reduce((sum, ms) => sum + ms, 0), 75000);
});

test('all photo failures exhaust ten retries before one diagnostic and a fresh text fallback', async () => {
  for (const status of [400, 401, 403, 429, 500, undefined]) {
    let photos = 0, texts = 0; const events = [];
    const result = await sendTelegramReport({ ...base,
      sendPhoto: async () => { photos++; assert.equal(events.length, 0); assert.equal(texts, 0); throw failure(status); },
      refreshMessage: () => ({ text: `fresh ${photos}`, entities: [] }), audit: event => events.push(event),
      sendText: async (_, text, extra) => {
        texts++; assert.equal(photos, 11); assert.equal(events.length, 1);
        assert.equal(text, 'fresh 11'); assert.deepEqual(extra.entities, []); return { message_id: 7 };
      } });
    assert.equal(result.message_id, 7); assert.equal(texts, 1);
    assert.equal(events[0].event, 'telegram_report_photo_failed');
    assert.equal(events[0].attempts, 11); assert.equal(events[0].retries, 10);
    assert.equal(events[0].errorCode, status ? String(status) : 'network');
    assert.equal(events[0].reason, status ? 'Bad Request: IMAGE_PROCESS_FAILED' : 'network');
  }
});

test('429 respects retry_after, including before text after the final photo failure', async () => {
  let photos = 0, elapsed = 0, failedAt = 0;
  await sendTelegramReport({ ...base, sleep: async ms => { elapsed += ms; },
    sendPhoto: async () => {
      if (photos) assert.ok(elapsed - failedAt >= 17000);
      photos++; failedAt = elapsed; throw Object.assign(failure(429), { retryAfter: 17 });
    }, sendText: async () => { assert.equal(photos, 11); assert.ok(elapsed - failedAt >= 17000); } });
});

test('each retry refreshes caption/entities and can switch to a long report', async () => {
  let photos = 0, texts = 0;
  const longText = '😀'.repeat(520);
  await sendTelegramReport({ ...base,
    refreshMessage: () => ({ text: photos ? longText : 'fresh title', entities: [] }),
    sendPhoto: async (_, __, extra) => {
      if (++photos === 1) { assert.equal(extra.caption, 'fresh title'); throw failure(400); }
      assert.equal(extra.caption, undefined); assert.equal(extra.disable_notification, true); return { message_id: 8 };
    }, sendText: async (_, text) => { texts++; assert.equal(photos, 2); assert.equal(text, longText); } });
  assert.equal(texts, 1);
});

test('long report sends complete text once, only after photo success or exhausted retries', async () => {
  for (const fails of [false, true]) {
    let photos = 0, texts = 0; const events = [];
    const text = '😀'.repeat(520);
    await sendTelegramReport({ ...base, text, audit: event => events.push(event),
      sendPhoto: async (_, __, extra) => {
        photos++; assert.equal(texts, 0); assert.equal(extra.caption, undefined); assert.equal(extra.disable_notification, true);
        if (fails) throw failure(400); return { message_id: 9 };
      }, sendText: async (_, body, extra) => {
        texts++; assert.equal(photos, fails ? 11 : 1); assert.equal(events.length, fails ? 1 : 0);
        assert.equal(body, text); assert.deepEqual(extra.entities, entities);
      } });
    assert.equal(texts, 1);
  }
});

test('access revocation during backoff or refresh cancels photo retries and text fallback', async () => {
  for (const point of ['wait', 'refresh', 'after-photo']) {
    let allowed = true, photos = 0;
    const result = await sendTelegramReport({ ...base, text: 'x'.repeat(1025), stillAllowed: () => allowed,
      sleep: async () => { if (point === 'wait') allowed = false; },
      refreshMessage: () => { if (point === 'refresh' && photos) allowed = false; return { text: base.text, entities }; },
      sendPhoto: async () => { photos++; if (point === 'after-photo') allowed = false; throw failure(400); },
      sendText: () => assert.fail('revoked access'), audit: () => assert.fail('not exhausted') });
    assert.equal(result, null); assert.equal(photos, 1);
  }
});

test('text errors after photo handling propagate without starting another photo loop', async () => {
  for (const fails of [false, true]) {
    let photos = 0;
    await assert.rejects(sendTelegramReport({ ...base, text: 'x'.repeat(1025),
      sendPhoto: async () => { photos++; if (fails) throw failure(400); return { message_id: 10 }; },
      sendText: async () => { throw failure(429); } }), error => error.status === 429 && error.reportPhotoHandled === true);
    assert.equal(photos, fails ? 11 : 1);
  }
});

test('diagnostics retain Telegram reason but redact credentials and never copy network error text', async () => {
  for (const status of [400, undefined]) {
    const events = [];
    const secret = '123456789:fake-telegram-token-for-tests-000';
    await sendTelegramReport({ ...base, audit: event => events.push(event),
      sendPhoto: async () => { throw Object.assign(Error(`Bad Request: IMAGE_PROCESS_FAILED https://api.telegram.org/bot${secret}/sendPhoto token=${secret}`), { status }); },
      sendText: async () => ({ message_id: 11 }) });
    assert.equal(events.length, 1); assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(events[0].reason.includes('https://'), false);
    if (status) assert.ok(events[0].reason.includes('IMAGE_PROCESS_FAILED'));
  }
});
