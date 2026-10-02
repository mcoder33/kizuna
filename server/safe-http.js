import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export function externalRequestError(code) {
  const error = new Error('Не удалось загрузить данные. Повторим при восстановлении сети.');
  error.code = code;
  error.presentation = { source: error.message };
  return error;
}

export const allowCaldavLocalhost = () => ['test', 'development'].includes(process.env.NODE_ENV)
  && process.env.PAGENT_CALDAV_ALLOW_LOCALHOST === '1';
const bareHost = hostname => hostname.replace(/^\[|\]$/g, '').toLowerCase();
const localHost = hostname => ['localhost', 'localhost.', '127.0.0.1', '::1'].includes(bareHost(hostname));

function ipv6Words(address) {
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const last = text.lastIndexOf(':');
    const octets = text.slice(last + 1).split('.').map(Number);
    text = text.slice(0, last + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = text.split('::');
  const left = halves[0] ? halves[0].split(':').map(word => parseInt(word, 16)) : [];
  const right = halves[1] ? halves[1].split(':').map(word => parseInt(word, 16)) : [];
  return halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%')) return false;
  const words = ipv6Words(address);
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return isPublicAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  // Global unicast only; exclude special-purpose, transition and documentation ranges.
  return (words[0] & 0xe000) === 0x2000 && words[0] !== 0x2002
    && !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8))
    && !(words[0] === 0x3fff && words[1] < 0x1000);
}
function acceptableAddress(address, loopback) {
  return loopback ? address === '::1' || (isIP(address) === 4 && /^127\./.test(address)) : isPublicAddress(address);
}

export function validateRemoteUrl(value, { base, serverUrl, preset = 'custom', allowLocalhost = allowCaldavLocalhost() } = {}) {
  let url;
  try { url = new URL(value, base); } catch { throw externalRequestError('unsafe_url'); }
  const loopback = allowLocalhost && localHost(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.hash)
    throw externalRequestError('unsafe_url');
  const host = bareHost(url.hostname);
  if ((isIP(host) && !acceptableAddress(host, loopback)) || (!loopback && localHost(host))) throw externalRequestError('unsafe_url');
  if (serverUrl) {
    const trusted = validateRemoteUrl(serverUrl, { allowLocalhost });
    // Apple's bootstrap explicitly discovers HTTPS pNN calendar shards. Custom accounts never get this exception.
    const appleShard = preset === 'icloud' && trusted.origin === 'https://caldav.icloud.com'
      && url.protocol === 'https:' && !url.port && /^p[0-9]{2,3}-caldav\.icloud\.com$/.test(host);
    if (url.origin !== trusted.origin && !appleShard) throw externalRequestError('unsafe_origin');
  }
  return url;
}

// Validate every A/AAAA answer inside the socket lookup, then return those exact addresses.
export function createPublicLookup({ lookup = dns.lookup, allowLocalhost = false } = {}) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    if (localHost(hostname) && !allowLocalhost) return callback(externalRequestError('unsafe_address'));
    lookup(hostname, { all: true, verbatim: true }, (error, records) => {
      if (error) return callback(error);
      const loopback = allowLocalhost && localHost(hostname);
      if (!records?.length || records.some(record => !acceptableAddress(record.address, loopback))) return callback(externalRequestError('unsafe_address'));
      const selected = options.family ? records.filter(record => record.family === options.family) : records;
      if (!selected.length) return callback(externalRequestError('unsafe_address'));
      if (options.all) callback(null, selected);
      else callback(null, selected[0].address, selected[0].family);
    });
  };
}

export function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason || externalRequestError('request_timeout')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
export async function withDeadline(operation, { timeoutMs = 20000, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || externalRequestError('request_timeout'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(externalRequestError('request_timeout')), timeoutMs);
  try { return await abortable(Promise.resolve().then(() => operation(controller.signal)), controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}

export async function readBoundedBody(response, { maxBytes, signal } = {}) {
  const declared = response.headers.get('content-length');
  const reader = response.body?.getReader();
  const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive safe integer');
    if (signal?.aborted) throw signal.reason || externalRequestError('request_timeout');
    if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw externalRequestError('response_too_large');
    if (!reader) return Buffer.alloc(0);
    signal?.addEventListener('abort', cancel, { once: true });
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw externalRequestError('response_too_large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) { cancel(); throw error; }
  finally { signal?.removeEventListener('abort', cancel); try { reader?.releaseLock(); } catch {} }
}

export function createSafeHttpFetch({ lookup = dns.lookup, request = null, allowLocalhost = allowCaldavLocalhost() } = {}) {
  return async (value, { method = 'GET', headers = {}, body, signal } = {}) => {
    const url = validateRemoteUrl(value, { allowLocalhost });
    const send = request || (url.protocol === 'https:' ? https.request : http.request);
    return abortable(new Promise((resolve, reject) => {
      const req = send(url, {
        method, headers: { ...headers, 'Accept-Encoding': 'identity' }, signal,
        lookup: createPublicLookup({ lookup, allowLocalhost }), agent: false,
        rejectUnauthorized: true,
      }, response => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
        if (responseHeaders.get('content-encoding') && responseHeaders.get('content-encoding') !== 'identity') {
          response.destroy(); reject(externalRequestError('unsupported_encoding')); return;
        }
        resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, headers: responseHeaders, body: Readable.toWeb(response) });
      });
      req.on('error', reject);
      req.end(body || undefined);
    }), signal);
  };
}
