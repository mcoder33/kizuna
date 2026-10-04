import fs from 'node:fs/promises';
import path from 'node:path';
import { safeEvent } from './observability.js';

const MiB = 1024 * 1024;
const integer = (value, fallback, min, max) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
export function logConfig(env = process.env) {
  return {
    maxFileBytes: integer(env.PAGENT_LOG_FILE_MIB, 8, 1, 16) * MiB,
    maxFiles: integer(env.PAGENT_LOG_FILES, 8, 2, 16),
    maxAgeMs: integer(env.PAGENT_LOG_DAYS, 14, 1, 30) * 86400000,
    minFreeBytes: integer(env.PAGENT_LOG_FREE_MIB, 512, 64, 4096) * MiB,
  };
}

// One serialized writer owns the files. The active file counts toward maxFiles.
// Disk writes never block a request; overload and disk failures drop telemetry,
// with fixed-size counters and a throttled diagnostic instead of recursive logs.
export function createLogStore({ directory, maxFileBytes = 8 * MiB, maxFiles = 8, maxAgeMs = 14 * 86400000,
  minFreeBytes = 512 * MiB, maxQueueBytes = MiB, maxEventBytes = 8192, now = () => Date.now(),
  statfs = fs.statfs, diagnostic = code => process.stderr.write(`Kizuna logging: ${code}\n`) } = {}) {
  if (!directory || !Number.isInteger(maxFiles) || maxFiles < 2 || maxFileBytes < maxEventBytes) throw new Error('Invalid log store configuration');
  const active = path.join(directory, 'events.jsonl');
  let queue = []; let queuedBytes = 0; let droppedEvents = 0; let writeFailures = 0; let logBytes = 0;
  let freeBytes = null; let lowDisk = false; let draining = null; let closed = false; let ready = false;
  let activeBytes = 0; let activeStarted = now(); let lastMaintenance = -Infinity; let lastDiagnostic = -Infinity;
  const warn = code => { if (now() - lastDiagnostic >= 60000) { lastDiagnostic = now(); try { diagnostic(code); } catch {} } };
  const fileFor = n => n === 0 ? active : path.join(directory, `events.${n}.jsonl`);
  async function initialize() {
    if (ready) return;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    try { const st = await fs.stat(active); activeBytes = st.size; activeStarted = st.birthtimeMs || st.mtimeMs; await fs.chmod(active, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    ready = true;
  }
  async function maintain() {
    if (now() - lastMaintenance < 5000) return;
    lastMaintenance = now();
    const disk = await statfs(directory);
    freeBytes = Number(disk.bavail) * Number(disk.bsize); lowDisk = freeBytes < minFreeBytes;
    logBytes = 0;
    for (const name of await fs.readdir(directory)) {
      if (!/^events(?:\.\d+)?\.jsonl$/.test(name)) continue;
      const file = path.join(directory, name); const st = await fs.stat(file);
      const slot = Number(name.match(/^events\.(\d+)\.jsonl$/)?.[1] || 0);
      if (name !== path.basename(fileFor(slot)) || slot >= maxFiles || now() - st.mtimeMs > maxAgeMs || st.size > maxFileBytes) {
        await fs.rm(file, { force: true });
        if (name === 'events.jsonl') { activeBytes = 0; activeStarted = now(); }
      } else { await fs.chmod(file, 0o600); logBytes += st.size; }
    }
  }
  async function rotate() {
    await fs.rm(fileFor(maxFiles - 1), { force: true });
    for (let slot = maxFiles - 2; slot >= 0; slot--) {
      try { await fs.rename(fileFor(slot), fileFor(slot + 1)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    activeBytes = 0; activeStarted = now();
  }
  async function drain() {
    try {
      await initialize(); await maintain();
      while (queue.length) {
        if (now() - lastMaintenance >= 5000) await maintain();
        const line = queue[0]; const bytes = Buffer.byteLength(line);
        if (lowDisk || freeBytes - bytes < minFreeBytes) { lowDisk = true; droppedEvents += queue.length; queue = []; queuedBytes = 0; warn('low_disk'); break; }
        if (activeBytes + bytes > maxFileBytes || now() - activeStarted > 86400000) await rotate();
        const limit = Math.min(64 * 1024, maxFileBytes - activeBytes, freeBytes - minFreeBytes);
        let batchCount = 0, batchBytes = 0;
        while (batchCount < queue.length && batchCount < 128) {
          const nextBytes = Buffer.byteLength(queue[batchCount]);
          if (batchBytes + nextBytes > limit) break;
          batchBytes += nextBytes; batchCount++;
        }
        await fs.appendFile(active, queue.slice(0, batchCount).join(''), { mode: 0o600 });
        activeBytes += batchBytes; logBytes = Math.min(maxFileBytes * maxFiles, logBytes + batchBytes);
        // Reserve free-space budget between statfs samples even on a burst.
        freeBytes -= batchBytes; lowDisk = freeBytes < minFreeBytes;
        queue.splice(0, batchCount); queuedBytes -= batchBytes;
      }
    } catch (error) {
      writeFailures++; droppedEvents += queue.length; queue = []; queuedBytes = 0;
      lastMaintenance = -Infinity; ready = false; warn(error?.code === 'ENOSPC' ? 'disk_full' : 'write_failed');
    }
  }
  function kick() {
    if (!draining) draining = drain().finally(() => { draining = null; if (queue.length) kick(); });
  }
  function write(event) {
    if (closed) return false;
    const line = JSON.stringify({ at: new Date(now()).toISOString(), schemaVersion: 1, service: 'kizuna', ...safeEvent(event) }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes > maxEventBytes || queuedBytes + bytes > maxQueueBytes) { droppedEvents++; warn('queue_full'); return false; }
    queue.push(line); queuedBytes += bytes; kick(); return true;
  }
  async function flush() { while (draining || queue.length) { if (!draining) kick(); await draining; } }
  async function maintenance() { await flush(); lastMaintenance = -Infinity; kick(); await flush(); }
  const maintenanceTimer = setInterval(() => { maintenance().catch(() => { writeFailures++; warn('maintenance_failed'); }); }, 60000); maintenanceTimer.unref();
  return { write, flush, maintenance, async close() { closed = true; clearInterval(maintenanceTimer); await flush(); },
    status: () => ({ queuedBytes, droppedEvents, writeFailures, logBytes, ...(freeBytes === null ? {} : {freeBytes}), lowDisk }),
    directory, limits: { maxFileBytes, maxFiles, maxAgeMs, minFreeBytes, maxQueueBytes } };
}

// Stream retained files, oldest first; never load the full retention into RAM.
export async function* readLogEvents(directory) {
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');
  const names = (await fs.readdir(directory)).filter(name => /^events(?:\.\d+)?\.jsonl$/.test(name))
    .sort((a, b) => Number(b.match(/\.(\d+)\.jsonl$/)?.[1] || 0) - Number(a.match(/\.(\d+)\.jsonl$/)?.[1] || 0));
  for (const name of names) {
    const stream = createReadStream(path.join(directory, name), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of lines) { try { const event = JSON.parse(line); if (event.schemaVersion === 1) yield event; } catch {} } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { lines.close(); stream.destroy(); }
  }
}
