import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleCalendarClient } from '../server/google-calendar.js';

const hasCode = code => error => error.code === code;
test('Google: responses are byte bounded, redirects disabled, stalled bodies cancelled', async () => {
  const large = createGoogleCalendarClient({ maxResponseBytes: 4, fetch: async (url, options) => { assert.equal(options.redirect, 'error'); return new Response('12345'); } });
  await assert.rejects(large.listCalendars({ accessToken: 'fixture' }), hasCode('response_too_large'));
  let cancelled = false;
  const hanging = createGoogleCalendarClient({ timeoutMs: 15, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await assert.rejects(hanging.listCalendars({ accessToken: 'fixture' }), hasCode('request_timeout'));
  assert.equal(cancelled, true);
});
test('Google: duplicate page tokens stop unbounded pagination and unsafe returned links disappear', async () => {
  let calls = 0;
  const loop = createGoogleCalendarClient({ fetch: async () => { calls++; return Response.json({ items: [], nextPageToken: 'again' }); } });
  await assert.rejects(loop.listCalendars({ accessToken: 'fixture' }), hasCode('response_too_large'));
  assert.equal(calls, 2);
  const events = createGoogleCalendarClient({ fetch: async () => Response.json({ items: [{ id: 'one', start: { dateTime: '2026-10-02T10:00:00Z' }, end: { dateTime: '2026-10-02T11:00:00Z' }, htmlLink: 'javascript:alert(1)', hangoutLink: 'data:text/html,x', conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'javascript:alert(2)' }] } }] }) });
  const [event] = await events.listEvents({ accessToken: 'fixture', calendarId: 'test', from: new Date('2026-10-02'), to: new Date('2026-10-03') });
  assert.equal(event.href, null); assert.equal(event.url, null); assert.equal(event.joinUrl, null);
});
