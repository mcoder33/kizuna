import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReportImageService, selectReportImageScene, reportImagePrompt } from '../server/report-images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=', 'base64');
const input = { date: '2026-10-03', phase: 'morning', now: new Date('2026-10-03T09:00:00Z'), timeZone: 'UTC', userId: 'local-owner' };
function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'kizuna-report-images-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const openaiEnv = () => ({ OPENAI_API_KEY: 'fake-secret' });

test('OpenAI uses official style references; concurrent recipients and restarts share one generated image', async t => {
  const dir = directory(t), calls = [], usages = [], events = [];
  const service = createReportImageService({ directory: dir, env: openaiEnv, audit: event => events.push(event), onUsage: (...args) => usages.push(args),
    fetch: async (url, request) => { calls.push({ url, request }); return response({ data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 12, output_tokens: 34 } }); } });
  const [a, b] = await Promise.all([service.prepare({ ...input, title: 'Private task title' }), service.prepare({ ...input, userId: 'another-user' })]);
  assert.deepEqual(a.bytes, png); assert.deepEqual(a, b); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/edits');
  assert.equal(calls[0].request.body.get('model'), 'gpt-image-1');
  assert.equal(calls[0].request.body.get('size'), '1536x1024');
  assert.equal(calls[0].request.body.getAll('image[]').length, 2);
  const prompt = calls[0].request.body.get('prompt');
  assert.ok(prompt.includes('torii-gate')); assert.ok(prompt.includes('#c73e3a')); assert.ok(prompt.includes('No grids'));
  assert.ok(!prompt.includes('Private task title')); assert.ok(!prompt.includes('local-owner'));
  assert.equal(usages[0][0].usage.outputTokens, 34); assert.equal(usages[0][1], 'local-owner');
  assert.ok(!JSON.stringify(events).includes('fake-secret'));
  await service.prepare(input); assert.equal(calls.length, 1);
  const reopened = createReportImageService({ directory: dir, env: () => ({}), fetch: () => { throw Error('must use disk cache'); } });
  assert.deepEqual((await reopened.prepare(input)).bytes, png);
  assert.ok(readdirSync(dir).includes('v1-2026-10-03-morning.attempt'));
});

test('Gemini receives the same mascot references and only the selected decorative scene', async t => {
  let call, usage;
  const service = createReportImageService({ directory: directory(t), env: () => ({ GEMINI_API_KEY: 'fake-google', OPENAI_API_KEY: 'fake-openai', PAGENT_AI_PROVIDER: 'gemini' }),
    onUsage: value => { usage = value; }, fetch: async (url, request) => { call = { url, request }; return response({ candidates: [{ content: { parts: [{ text: 'An illustration' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }], usageMetadata: { promptTokenCount: 23, candidatesTokenCount: 45 } }); } });
  assert.deepEqual((await service.prepare({ ...input, phase: 'evening' })).bytes, png);
  assert.ok(call.url.endsWith('/gemini-2.5-flash-image:generateContent'));
  assert.equal(call.request.headers['x-goog-api-key'], 'fake-google');
  const body = JSON.parse(call.request.body);
  assert.equal(body.contents[0].parts.filter(part => part.inlineData).length, 2);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '3:2');
  assert.ok(body.contents[0].parts[0].text.includes('Evening or blue hour'));
  assert.equal(usage.usage.outputTokens, 45);
});

test('daily scenes and morning/evening differ; seasonal fallback artwork exists for every date', () => {
  for (const month of ['01', '04', '07', '10']) {
    let previous;
    for (let day = 1; day <= 16; day++) {
      const date = `2026-${month}-${String(day).padStart(2, '0')}`;
      const morning = selectReportImageScene(date, 'morning'), evening = selectReportImageScene(date, 'evening');
      assert.notEqual(morning.scene, previous); assert.notEqual(morning.scene, evening.scene);
      assert.notEqual(morning.fallback, evening.fallback);
      for (const scene of [morning, evening]) assert.ok(readFileSync(new URL(`../public/release-cards/${scene.fallback}`, import.meta.url)).length > 1000);
      previous = morning.scene;
    }
  }
  assert.throws(() => selectReportImageScene('../../file', 'morning'), RangeError);
  assert.ok(reportImagePrompt('1901-01-01', 'morning').includes('winter:'));
});

test('no key, exhausted budget and historical/future dates use a ready image without paid calls; off gives text only', async t => {
  let calls = 0;
  const fetch = () => { calls++; throw Error('must not call'); };
  for (const options of [{ env: () => ({}) }, { env: openaiEnv, allowGenerate: () => false }]) {
    const service = createReportImageService({ directory: directory(t), fetch, ...options });
    assert.ok((await service.prepare(input)).bytes.length > 1000);
  }
  const service = createReportImageService({ directory: directory(t), env: openaiEnv, fetch });
  for (const date of ['2026-10-02', '2026-10-04']) assert.ok((await service.prepare({ ...input, date })).bytes.length > 1000);
  assert.equal(await service.prepare({ ...input, date: '2026-02-30' }), null);
  const disabled = createReportImageService({ directory: directory(t), env: () => ({ ...openaiEnv(), PAGENT_REPORT_IMAGE_PROVIDER: 'off' }), fetch });
  assert.equal(await disabled.prepare(input), null); assert.equal(calls, 0);
});

test('provider failure, timeout and malformed image fall back silently and never retry after restart', async t => {
  for (const mode of ['provider', 'timeout', 'invalid-image']) {
    const dir = directory(t); let calls = 0; const events = [];
    const options = { directory: dir, env: openaiEnv, timeoutMs: 15, audit: event => events.push(event), fetch: async () => {
      calls++; if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'provider') return new Response('private secret from provider', { status: 429 });
      return response({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
    } };
    const service = createReportImageService(options);
    assert.ok((await service.prepare(input)).bytes.length > 1000);
    await service.prepare(input); await createReportImageService(options).prepare(input);
    assert.equal(calls, 1, mode); assert.ok(!JSON.stringify(events).includes('private secret'));
  }
});

test('an interrupted attempt does not regenerate; corrupt cache is ignored and old cache is pruned', async t => {
  const dir = directory(t); let calls = 0;
  writeFileSync(join(dir, 'v1-2026-10-03-morning.img'), 'corrupt');
  writeFileSync(join(dir, 'v1-2026-10-03-morning.attempt'), '');
  writeFileSync(join(dir, 'v1-2026-08-01-evening.img'), png);
  writeFileSync(join(dir, 'v1-2026-08-01-evening.attempt'), '');
  writeFileSync(join(dir, 'other-file'), 'retain');
  const service = createReportImageService({ directory: dir, env: openaiEnv, fetch: async () => { calls++; return response({ data: [{ b64_json: png.toString('base64') }] }); } });
  assert.ok((await service.prepare(input)).bytes.length > 1000); assert.equal(calls, 0);
  assert.ok(!readdirSync(dir).includes('v1-2026-08-01-evening.img')); assert.ok(readdirSync(dir).includes('other-file'));
  await service.prepare({ ...input, phase: 'evening' }); assert.equal(calls, 1);
});

test('manual current-day reports use local morning/evening and share the scheduled cache', async t => {
  let calls = 0;
  const service = createReportImageService({ directory: directory(t), env: openaiEnv, fetch: async () => { calls++; return response({ data: [{ b64_json: png.toString('base64') }] }); } });
  await service.prepare({ ...input, phase: 'manual', now: new Date('2026-10-03T08:00:00Z'), timeZone: 'Europe/Samara' });
  await service.prepare(input); assert.equal(calls, 1);
  await service.prepare({ ...input, phase: 'manual', now: new Date('2026-10-03T14:00:00Z'), timeZone: 'Europe/Samara' });
  await service.prepare({ ...input, phase: 'evening' }); assert.equal(calls, 2);
});
