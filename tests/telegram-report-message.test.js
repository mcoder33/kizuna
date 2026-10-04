import test from 'node:test';
import assert from 'node:assert/strict';
import { sendTelegramReport, createTelegramReportPacer } from '../server/telegram-report-message.js';

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

test('multiline caption entity offsets survive actual multipart CRLF normalization', async () => {
  const text = '☀️ Утро\nСамара\n\nСегодня можно продолжить начатое 🌱\n\nЧто остаётся в работе:\n⬜ Карусель 🐈';
  const titles = ['☀️ Утро','Что остаётся в работе:','Карусель 🐈'];
  const entities = titles.map(title => ({ type:'bold', offset:text.indexOf(title), length:title.length }));
  let wire;
  await sendTelegramReport({ ...base, text, entities,
    sendPhoto: async (_,__,extra) => {
      const form = new FormData(); form.append('caption',extra.caption); form.append('caption_entities',JSON.stringify(extra.caption_entities));
      wire = await new Response(form).formData(); return { message_id:30 };
    }, sendText: () => assert.fail('must deliver the captioned photo') });
  const caption = wire.get('caption'), sentEntities = JSON.parse(wire.get('caption_entities'));
  assert.equal(caption,text.replace(/\n/g,'\r\n'));
  assert.deepEqual(sentEntities.map(entity => caption.slice(entity.offset,entity.offset+entity.length)),titles);
  for(const entity of sentEntities)assert.ok(!/[\uDC00-\uDFFF]/.test(caption[entity.offset]));
});

test('caption limit counts normalized multipart newlines and preserves long text separately', async () => {
  const text = 'A\n'.repeat(510), calls=[];
  await sendTelegramReport({ ...base, text, entities:[],
    sendPhoto: async (_,__,extra) => { calls.push(['photo',extra]); return { message_id:31 }; },
    sendText: async (_,body) => { calls.push(['text',body]); return { message_id:32 }; } });
  assert.equal(calls[0][0],'photo');assert.equal(calls[0][1].caption,undefined);
  assert.deepEqual(calls[1],['text',text]);
});

test('photo may succeed on the tenth retry without failure logging or text fallback', async () => {
  let photos = 0, elapsed = 0; const pauses = [], starts = [];
  const result = await sendTelegramReport({ ...base, clock: () => elapsed, sleep: async ms => { pauses.push(ms); elapsed += ms; },
    sendPhoto: async () => { starts.push(elapsed); if (++photos <= 10) throw failure(400); return { message_id: 6 }; },
    sendText: () => assert.fail('must not send text'), audit: () => assert.fail('must not log a final failure') });
  assert.equal(result.message_id, 6); assert.equal(photos, 11);
  assert.equal(pauses.reduce((sum, ms) => sum + ms, 0), 55000);
  assert.deepEqual(starts.slice(1).map((at, index) => at - starts[index]), [1000,2000,3000,4000,5000,6000,7000,8000,9000,10000]);
});

test('shared pacing spaces photo, text and the next recipient by at least one second', async () => {
  let elapsed = 0; const starts = [];
  const sleep = async ms => { elapsed += ms; };
  const pace = createTelegramReportPacer({ sleep, clock: () => elapsed });
  const sendPhoto = async () => { starts.push(['photo',elapsed]); return { message_id: 20 }; };
  const sendText = async () => { starts.push(['text',elapsed]); return { message_id: 21 }; };
  await sendTelegramReport({ ...base, text: 'x'.repeat(1025), pace, sleep, sendPhoto, sendText });
  await sendTelegramReport({ ...base, chatId: 456, image: null, pace, sleep, sendPhoto, sendText });
  assert.deepEqual(starts, [['photo',0],['text',1000],['text',2000]]);
});

test('concurrent recipients share pacing and a failed request cannot break the queue', async () => {
  let elapsed = 0; const starts = [];
  const pace = createTelegramReportPacer({ sleep: async ms => { elapsed += ms; }, clock: () => elapsed });
  const failed = pace(async () => { starts.push(elapsed); throw failure(400); });
  const second = pace(async () => { starts.push(elapsed); return 2; });
  const third = pace(async () => { starts.push(elapsed); return 3; });
  await assert.rejects(failed); assert.equal(await second,2); assert.equal(await third,3);
  assert.deepEqual(starts,[0,1000,2000]);
});

test('access and content are checked after the one-second send spacing', async () => {
  let elapsed = 0, allowed = true, title = 'private title';
  const pace = createTelegramReportPacer({ sleep: async ms => { elapsed += ms; title='fresh title'; }, clock: () => elapsed });
  await pace(async () => {});
  await sendTelegramReport({ ...base, pace, refreshMessage: () => ({ text: title, entities: [] }),
    sendPhoto: async (_,__,extra) => { assert.equal(elapsed,1000); assert.equal(extra.caption,'fresh title'); return { message_id: 22 }; },
    sendText: () => assert.fail('short photo report') });
  const revoked = createTelegramReportPacer({ sleep: async () => { allowed=false; }, clock: () => 0 });
  await revoked(async () => {});
  assert.equal(await revoked(() => assert.fail('revoked access'), () => allowed),null);
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

test('429 respects retry_after and continues increasing pauses, including a wait before final text', async () => {
  let photos = 0, elapsed = 0, failedAt = 0;
  const gaps = [];
  await sendTelegramReport({ ...base, clock: () => elapsed, sleep: async ms => { elapsed += ms; },
    sendPhoto: async () => {
      if (photos) { assert.ok(elapsed - failedAt >= 17000); gaps.push(elapsed - failedAt); }
      photos++; failedAt = elapsed; throw Object.assign(failure(429), { retryAfter: 17 });
    }, sendText: async () => { assert.equal(photos, 11); assert.ok(elapsed - failedAt >= 17000); } });
  assert.deepEqual(gaps, [17000,18000,19000,20000,21000,22000,23000,24000,25000,26000]);
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
