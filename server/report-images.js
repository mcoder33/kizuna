import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validIsoDate } from './repeat.js';
import { dateInZone } from './reports.js';
import { readBoundedBody, withDeadline } from './safe-http.js';

const cardsDirectory = fileURLToPath(new URL('../public/release-cards/', import.meta.url));
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const maxImageBytes = 8 * 1024 * 1024;
const version = 'v1';
const scenes = {
  morning: [
    'walking along a curved stepping-stone path in a Japanese garden, carrying a small closed cream notebook',
    'watering a little green sapling in a speckled ceramic pot on a wooden veranda',
    'enjoying a cup of tea beside an open blank notebook at a sunny wooden desk',
    'opening a shoji window to let the morning light into a quiet Japanese cottage',
    'crossing a little wooden bridge over a garden stream, carrying a small cloth bag',
    'arranging a single seasonal branch in a ceramic vase on a low wooden table',
    'sitting on a garden bench with a closed notebook, looking at Mount Fuji beyond the lake',
    'preparing tea beside a small kettle in a bright cozy kitchen',
  ],
  evening: [
    'reading an open blank book on a cushion beside a low tea table in a tatami reading nook',
    'holding a glowing paper lantern beside a peaceful lakeside wooden bridge',
    'enjoying a warm cup of tea on a wooden veranda, with a closed cream notebook nearby',
    'watching the moon and its reflection from a quiet garden bench by the lake',
    'placing a closed notebook on a wooden desk beside a soft paper lamp',
    'sitting comfortably beside a shoji window, wrapped in a small cozy blanket',
    'taking a quiet walk along a lantern-lit garden path',
    'listening to gentle rain from a sheltered veranda beside a warm cup of tea',
  ],
};
const seasons = {
  spring: 'spring: fresh green leaves and delicate cherry blossoms',
  summer: 'summer: lush greenery, a light breeze and small fireflies at night',
  autumn: 'autumn: golden and red maple leaves and natural warm wood',
  winter: 'winter: snow outside and a cozy sheltered setting',
};
const angles = ['a wide three-quarter view', 'a closer eye-level view', 'a gentle side view', 'a view framed by a shoji doorway', 'a slightly elevated view'];

export function selectReportImageScene(date, phase) {
  if (!validIsoDate(date) || !scenes[phase]) throw new RangeError('Invalid report image day');
  const ordinal = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const index = length => ((ordinal % length) + length) % length;
  const month = Number(date.slice(5, 7));
  const season = month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter';
  return { season, scene: scenes[phase][index(scenes[phase].length)], angle: angles[index(angles.length)],
    fallback: `${season}-${weekdays[(index(weekdays.length) + (phase === 'evening' ? 3 : 0)) % weekdays.length]}.png` };
}

export function reportImagePrompt(date, phase) {
  const { season, scene, angle } = selectReportImageScene(date, phase);
  return `Create ONE landscape illustration for a Kizuna daily report, using the supplied official release illustrations as strict visual references.
Preserve the same recognizable red torii-gate mascot: two red rectangular posts as the body and legs, a red crossbar with a smiling face, closed curved black eyes, small round pink cheeks, soft little black arms, and a thick charcoal-black gently upcurved roof lintel. Brand red is #c73e3a. Keep its proportions, materials and face consistent.
Style: a beautifully crafted miniature clay-and-wood stop-motion scene, realistic painted texture, warm cinematic light, soft depth of field, Japanese cottage and garden details, natural ceramics and wood. Match the reference artwork; no flat vector, anime or watercolor.
Scene: the mascot is ${scene}. Composition: ${angle}. Season: ${seasons[season]}.
${phase === 'morning' ? 'Early morning, soft golden daylight, a calm and welcoming beginning to the day.' : 'Evening or blue hour, indigo sky, soft lantern light, a calm restful end to the day.'}
One coherent scene with one mascot. No grids, panels, UI, buttons, lettering, words, numbers, dates, task lists, check marks or claims about completed work. Notebook and book pages are blank. The picture is decorative; never depict or invent the user’s tasks.`;
}

function imageFile(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > maxImageBytes) throw new Error('invalid_image');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { bytes, type: 'image/png', filename: 'kizuna-report.png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { bytes, type: 'image/jpeg', filename: 'kizuna-report.jpg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { bytes, type: 'image/webp', filename: 'kizuna-report.webp' };
  throw new Error('invalid_image');
}
function decodeImage(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid_image');
  return imageFile(Buffer.from(value, 'base64'));
}
function imageConfig(env) {
  const requested = env.PAGENT_REPORT_IMAGE_PROVIDER || 'auto';
  if (requested === 'off') return { off: true };
  const googleKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const provider = requested === 'auto' ? (env.PAGENT_AI_PROVIDER === 'gemini' && googleKey ? 'gemini' : env.OPENAI_API_KEY ? 'openai' : googleKey ? 'gemini' : null) : requested;
  const apiKey = provider === 'openai' ? env.OPENAI_API_KEY : provider === 'gemini' ? googleKey : null;
  const model = env.PAGENT_REPORT_IMAGE_MODEL || (provider === 'openai' ? 'gpt-image-1' : 'gemini-2.5-flash-image');
  return apiKey && /^[A-Za-z0-9._-]{1,120}$/.test(model) ? { provider, apiKey, model } : null;
}

// One shared, decorative image per local date/phase, never one paid call per user.
// A durable attempt marker also prevents a restart after a timeout from charging again.
export function createReportImageService({ directory, env = () => process.env, fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 90000, allowGenerate = () => true, onUsage = () => {}, audit = () => {} } = {}) {
  const pending = new Map(), memory = new Map();
  const note = event => { try { audit(event); } catch {} };
  function fallback(date, phase) {
    try { return imageFile(fs.readFileSync(path.join(cardsDirectory, selectReportImageScene(date, phase).fallback))); }
    catch { return null; }
  }
  function cached(file) {
    try { if (fs.statSync(file).size <= maxImageBytes) return imageFile(fs.readFileSync(file)); } catch {}
    return null;
  }
  function save(file, image) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, image.bytes, { mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  function prune(date) {
    const cutoff = Date.parse(`${date}T00:00:00Z`) - 30 * 86400000;
    for (const name of fs.readdirSync(directory)) {
      const match = /^v1-(\d{4}-\d{2}-\d{2})-(morning|evening)\.(img|attempt)$/.exec(name);
      if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) try { fs.unlinkSync(path.join(directory, name)); } catch {}
    }
  }
  async function generate(config, date, phase, userId) {
    const { season } = selectReportImageScene(date, phase);
    const references = ['autumn-sat.png', `${season}-sun.png`].map(name => fs.readFileSync(path.join(cardsDirectory, name)));
    const prompt = reportImagePrompt(date, phase);
    return withDeadline(async signal => {
      let url, request;
      if (config.provider === 'openai') {
        const form = new FormData();
        for (const [key, value] of Object.entries({ model: config.model, prompt, n: '1', size: '1536x1024', quality: 'medium' })) form.append(key, value);
        references.forEach((bytes, index) => form.append('image[]', new Blob([bytes], { type: 'image/png' }), `reference-${index}.png`));
        url = 'https://api.openai.com/v1/images/edits';
        request = { headers: { Authorization: `Bearer ${config.apiKey}` }, body: form };
      } else {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;
        request = { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey }, body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, ...references.map(bytes => ({ inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }))] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:2' } },
        }) };
      }
      const response = await fetchImpl(url, { method: 'POST', ...request, signal, redirect: 'error' });
      if (!response.ok) throw new Error('image_provider_unavailable');
      const body = JSON.parse((await readBoundedBody(response, { maxBytes: 12 * 1024 * 1024, signal })).toString('utf8'));
      const encoded = config.provider === 'openai' ? body.data?.[0]?.b64_json : body.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData.data;
      const image = decodeImage(encoded);
      const usage = config.provider === 'openai' ? body.usage : body.usageMetadata;
      try { onUsage({ usedProvider: config.provider, model: config.model, usage: {
        inputTokens: usage?.input_tokens ?? usage?.promptTokenCount ?? 0,
        outputTokens: usage?.output_tokens ?? usage?.candidatesTokenCount ?? 0, costUsd: null,
      } }, userId); } catch {}
      note({ event: 'telegram_report_image_generated', provider: config.provider, model: config.model });
      return image;
    }, { timeoutMs });
  }
  async function prepare({ date, phase, timeZone = 'Europe/Samara', now = new Date(), userId } = {}) {
    if (!validIsoDate(date)) return null;
    const config = imageConfig(env());
    if (config?.off) return null;
    if (phase === 'manual') phase = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now)) < 17 ? 'morning' : 'evening';
    if (!scenes[phase]) return null;
    const key = `${version}-${date}-${phase}`;
    if (memory.has(key)) return memory.get(key);
    if (pending.has(key)) return pending.get(key);
    const saved = directory && cached(path.join(directory, `${key}.img`));
    if (saved) return saved;
    if (!directory || !config || date !== dateInZone(now, timeZone) || !allowGenerate(userId)) return fallback(date, phase);
    const operation = (async () => {
      let image;
      try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${key}.img`);
        image = cached(file);
        if (!image) {
          prune(date);
          const marker = path.join(directory, `${key}.attempt`);
          try { fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 }); }
          catch (error) { if (error.code === 'EEXIST') return fallback(date, phase); throw error; }
          try { image = await generate(config, date, phase, userId); }
          catch { note({ event: 'telegram_report_image_fallback', reason: 'generation_unavailable' }); image = fallback(date, phase); }
          if (image) save(file, image);
        }
        if (image) { if (memory.size >= 8) memory.delete(memory.keys().next().value); memory.set(key, image); }
        return image;
      } catch { note({ event: 'telegram_report_image_fallback', reason: 'cache_unavailable' }); return image || fallback(date, phase); }
    })();
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  }
  return { prepare };
}
