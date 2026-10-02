// M2/M3/L4: reject excess work before password hashing, with bounded memory.
export function createAdmission({ now = Date.now, windowMs = 60_000, maxKeys = 4096, maxConcurrent = 4, ipLimit = 60, pairLimit = 8, registerLimit = 10, globalLimit = 120 } = {}) {
  const buckets = new Map(); let active = 0;
  function take(key, limit, at) {
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= at) {
      if (!bucket && buckets.size >= maxKeys) {
        for (const [storedKey, value] of buckets) if (value.until <= at) buckets.delete(storedKey);
        if (buckets.size >= maxKeys) return false;
      }
      bucket = { until: at + windowMs, count: 0 }; buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return false;
    bucket.count++; return true;
  }
  return {
    enter({ ip, email = '', kind = 'login' }) {
      const at = Number(now());
      if (active >= maxConcurrent || !take(`ip:${ip}`, ipLimit, at)
        || !take(`${kind}:${ip}:${String(email).slice(0, 254)}`, kind === 'register' ? registerLimit : pairLimit, at)
        || (kind === 'register' && !take(`register:${ip}`, registerLimit, at)) || !take('global', globalLimit, at)) return null;
      active++; let released = false;
      return () => { if (!released) { released = true; active--; } };
    },
    get active() { return active; },
    get size() { return buckets.size; },
  };
}
