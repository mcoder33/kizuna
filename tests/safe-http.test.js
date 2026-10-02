import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { validateRemoteUrl, isPublicAddress, createPublicLookup, createSafeHttpFetch, readBoundedBody, withDeadline, allowCaldavLocalhost } from '../server/safe-http.js';
import { safeExternalUrl } from '../public/safe-url.js';

const rejectsCode = code => error => error.code === code;

test('external URLs reject unusual private IP forms, IPv6, credentials, downgrade and foreign origin', () => {
  for (const host of ['127.1', '2130706433', '0x7f000001', '0177.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '[::1]', '[fc00::1]', '[fe80::1]', '[::ffff:192.168.1.1]', '[64:ff9b::a00:1]', '[2002:a00:1::]']) {
    assert.throws(() => validateRemoteUrl(`https://${host}/`, { allowLocalhost: false }), rejectsCode('unsafe_url'), host);
  }
  for (const value of ['http://calendar.example/', 'javascript:alert(1)', 'https://user:pass@calendar.example/', 'https://calendar.example/#fragment']) assert.throws(() => validateRemoteUrl(value), rejectsCode('unsafe_url'));
  assert.throws(() => validateRemoteUrl('https://other.example/event', { serverUrl: 'https://calendar.example/' }), rejectsCode('unsafe_origin'));
  assert.equal(validateRemoteUrl('/event', { base: 'https://calendar.example/c/', serverUrl: 'https://calendar.example' }).href, 'https://calendar.example/event');
  assert.ok(isPublicAddress('8.8.8.8'));
  assert.ok(isPublicAddress('2606:4700:4700::1111'));
  assert.ok(!isPublicAddress('2001:db8::1'));
});

test('only the explicit nonproduction flag permits loopback, never LAN/metadata', () => {
  const old = { mode: process.env.NODE_ENV, flag: process.env.PAGENT_CALDAV_ALLOW_LOCALHOST };
  try {
    process.env.NODE_ENV = 'test'; delete process.env.PAGENT_CALDAV_ALLOW_LOCALHOST;
    assert.equal(allowCaldavLocalhost(), false);
    process.env.PAGENT_CALDAV_ALLOW_LOCALHOST = '1'; assert.equal(allowCaldavLocalhost(), true);
    assert.equal(validateRemoteUrl('http://localhost:8080/').hostname, 'localhost');
    for (const host of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254']) assert.throws(() => validateRemoteUrl(`https://${host}/`));
    process.env.NODE_ENV = 'production'; assert.equal(allowCaldavLocalhost(), false);
    assert.throws(() => validateRemoteUrl('http://localhost:8080/'));
  } finally {
    for (const [key, value] of [['NODE_ENV', old.mode], ['PAGENT_CALDAV_ALLOW_LOCALHOST', old.flag]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('DNS validates all A/AAAA even for a requested family and returns exact pinned results', async () => {
  const lookup = (host, options, callback) => { assert.deepEqual(options, { all: true, verbatim: true }); callback(null, [{ address: '8.8.8.8', family: 4 }, { address: 'fc00::1', family: 6 }]); };
  const guarded = createPublicLookup({ lookup });
  await assert.rejects(new Promise((resolve, reject) => guarded('calendar.example', { family: 4 }, (error, value) => error ? reject(error) : resolve(value))), rejectsCode('unsafe_address'));
  const records = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  const publicLookup = createPublicLookup({ lookup: (host, options, callback) => callback(null, records) });
  assert.deepEqual(await new Promise((resolve, reject) => publicLookup('calendar.example', { all: true }, (error, value) => error ? reject(error) : resolve(value))), records);
  for (const address of ['192.168.1.1', '8.8.8.8']) {
    const fakeLocal = createPublicLookup({ allowLocalhost: true, lookup: (host, options, callback) => callback(null, [{ address, family: 4 }]) });
    await assert.rejects(new Promise((resolve, reject) => fakeLocal('localhost', {}, (error, value) => error ? reject(error) : resolve(value))), rejectsCode('unsafe_address'));
  }
});

test('native transport uses the validated socket lookup each connection and keeps hostname/TLS checks', async () => {
  let resolutions = 0, connected = [];
  const transport = createSafeHttpFetch({
    lookup: (host, options, callback) => callback(null, [{ address: ++resolutions === 1 ? '8.8.8.8' : '169.254.169.254', family: 4 }]),
    request: (url, options, callback) => {
      assert.equal(url.hostname, 'calendar.example'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
      const req = new EventEmitter();
      req.end = () => options.lookup(url.hostname, {}, (error, address) => {
        if (error) { req.emit('error', error); return; }
        connected.push(address);
        const response = Readable.from([Buffer.from('ok')]); response.headers = {}; response.statusCode = 200;
        callback(response);
      });
      return req;
    },
  });
  const response = await transport('https://calendar.example/');
  assert.equal((await readBoundedBody(response, { maxBytes: 2 })).toString(), 'ok');
  await assert.rejects(transport('https://calendar.example/'), rejectsCode('unsafe_address'));
  assert.deepEqual(connected, ['8.8.8.8']); assert.equal(resolutions, 2);
});

test('stream reader rejects advertised or chunked excess before buffering and counts UTF-8 bytes', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('12345')); }, cancel() { cancelled++; } });
  await assert.rejects(readBoundedBody(new Response(body, { headers: { 'Content-Length': '500' } }), { maxBytes: 4 }), rejectsCode('response_too_large'));
  assert.equal(cancelled, 1);
  const chunks = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('аб')); controller.enqueue(new TextEncoder().encode('в')); }, cancel() { cancelled++; } });
  await assert.rejects(readBoundedBody(new Response(chunks, { headers: { 'Content-Length': '1' } }), { maxBytes: 5 }), rejectsCode('response_too_large'));
  assert.equal(cancelled, 2);
  assert.equal((await readBoundedBody(new Response('аб'), { maxBytes: 4 })).length, 4);
  for (const maxBytes of [undefined, 0, -1, Infinity]) await assert.rejects(readBoundedBody(new Response('x'), { maxBytes }), /positive safe integer/);
});

test('deadline aborts and cancels stalled response bodies, including native local fixture sockets', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(withDeadline(signal => readBoundedBody(response, { maxBytes: 4, signal }), { timeoutMs: 15 }), rejectsCode('request_timeout'));
  assert.equal(cancelled, true);
  const server = http.createServer((req, res) => { res.writeHead(200); res.write('a'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const transport = createSafeHttpFetch({ allowLocalhost: true });
    await assert.rejects(withDeadline(async signal => readBoundedBody(await transport(`http://127.0.0.1:${server.address().port}/`, { signal }), { maxBytes: 4, signal }), { timeoutMs: 30 }), /./);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('presentation links reject stored executable/relative/malformed URLs without changing safe URLs', () => {
  for (const value of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '/local', '//example.com', 'httpx://example.com', 'https://u:p@example.com/', 'https://exa\nmple.com']) assert.equal(safeExternalUrl(value), null);
  assert.equal(safeExternalUrl('https://meet.google.com/a?x=1#join'), 'https://meet.google.com/a?x=1#join');
});
