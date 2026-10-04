import path from 'node:path';
import { readLogEvents } from '../server/log-store.js';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(`--${name}`); return at < 0 ? null : args[at + 1]; };
if (args.includes('--help')) {
  console.log('node scripts/log-report.mjs --directory /opt/kizuna/data/logs [--since ISO] [--user-id UUID] [--flow-id UUID] [--capture-id UUID] [--errors] [--timeline | --events]');
  process.exit(0);
}
const directory = option('directory') || process.env.PAGENT_LOG_DIR || path.join(path.dirname(process.env.PAGENT_DB_PATH || 'data/pagent.sqlite'), 'logs');
const filters = Object.fromEntries(['user-id','flow-id','capture-id'].map(key => [key.replace(/-([a-z])/g, (_, char) => char.toUpperCase()), option(key)]).filter(([, value]) => value));
const since = option('since') ? Date.parse(option('since')) : null;
if (since !== null && !Number.isFinite(since)) throw new Error('--since должен быть датой ISO');
const groups = new Map(), funnel = new Map(), timeline = [], failures = [];
let count = 0, errors = 0, warnings = 0, runtime = null;
const stages = new Set(['capture_focused','capture_submit','capture_accepted','capture_abandoned','capture_result_visible','capture_submit_failed','native_opened','native_submit','native_accepted','native_abandoned']);
try {
  for await (const event of readLogEvents(directory)) {
    if (Object.entries(filters).some(([key, value]) => event[key] !== value) || (since !== null && Date.parse(event.at) < since)) continue;
    if (args.includes('--errors') && event.level !== 'error' && event.level !== 'warn') continue;
    count++; if (event.level === 'error') errors++; if (event.level === 'warn') warnings++;
    if (args.includes('--events')) { console.log(JSON.stringify(event)); continue; }
    if (args.includes('--timeline')) { timeline.push(event); if (timeline.length > 500) timeline.shift(); }
    if (event.level === 'error' || event.level === 'warn') { failures.push(event); if (failures.length > 20) failures.shift(); }
    if (event.event === 'runtime_health') runtime = event;
    if (stages.has(event.event)) {
      if (!funnel.has(event.event)) funnel.set(event.event, new Set());
      const flows = funnel.get(event.event); if (flows.size < 10000) flows.add(event.flowId || `${event.pageId}:${event.seq}`);
    }
    if (typeof event.durationMs !== 'number' || event.event === 'stream_closed') continue;
    const name = event.route ? `${event.method || ''} ${event.route}` : event.operation || event.event;
    if (!groups.has(name)) { if (groups.size >= 300) continue; groups.set(name, { count:0, failed:0, slow:0, total:0, max:0, samples:[] }); }
    const group = groups.get(name); group.count++; group.failed += event.result === 'failed' ? 1 : 0; group.slow += event.slow ? 1 : 0;
    group.total += event.durationMs; group.max = Math.max(group.max, event.durationMs);
    if (group.samples.length < 2000) group.samples.push(event.durationMs);
    else { const slot = Math.floor(Math.random() * group.count); if (slot < 2000) group.samples[slot] = event.durationMs; }
  }
  if (!args.includes('--events')) {
    const round = value => Math.round(value * 10) / 10;
    const latency = [...groups].map(([operation, group]) => {
      group.samples.sort((a,b) => a-b);
      return { operation, count:group.count, failed:group.failed, slow:group.slow, meanMs:round(group.total/group.count),
        p95Ms:round(group.samples[Math.min(group.samples.length-1,Math.ceil(group.samples.length*0.95)-1)]), maxMs:round(group.max), sampled:group.count>2000 };
    }).sort((a,b) => b.maxMs-a.maxMs);
    if (args.includes('--timeline')) timeline.sort((a,b) => Date.parse(a.clientAt || a.at)-Date.parse(b.clientAt || b.at));
    console.log(JSON.stringify({ retainedEvents:count, errors, warnings, funnelUniqueFlows:Object.fromEntries([...funnel].map(([name, flows]) => [name,flows.size])),
      latency, latestRuntime:runtime, latestProblems:failures, ...(args.includes('--timeline') ? {timeline, timelineLimit:500} : {}) }, null, 2));
  }
} catch (error) { console.error(error.code === 'ENOENT' ? 'Каталог логов пока не создан.' : 'Не удалось прочитать логи.'); process.exitCode = 1; }
