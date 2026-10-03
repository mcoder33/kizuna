import net from 'node:net';

export function loopbackProxy(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
export function clientAddress(req) {
  const address = req.ip || req.socket?.remoteAddress || '';
  return net.isIP(address) ? address : 'unknown';
}
export function createHttpSecurity({ publicUrl = process.env.PAGENT_PUBLIC_URL, secureCookies = process.env.PAGENT_SECURE_COOKIES === 'on' } = {}) {
  let configured = null;
  if (publicUrl) {
    configured = new URL(publicUrl);
    if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.search || configured.hash)
      throw new Error('Invalid PAGENT_PUBLIC_URL');
    if (configured.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname)) throw new Error('Public URL must use HTTPS');
  }
  const origins = new Set(['https://yourkizuna.com', 'https://kizuna.agent-hub.space']);
  if (configured) origins.add(configured.origin);
  function baseUrl(req) {
    if (configured) return configured.origin;
    const host = req.get('host') || '';
    let parsed;
    try { parsed = new URL(`${req.protocol}://${host}`); } catch { throw new Error('Invalid request host'); }
    if (origins.has(parsed.origin) || ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return parsed.origin;
    throw new Error('Untrusted request host');
  }
  function allowedOrigin(req, { required = false } = {}) {
    const origin=req.headers?.origin;
    if (!origin) return !required;
    if(req.headers?.['sec-fetch-site']==='cross-site')return false;
    if(origins.has(origin))return true;
    try { return origin===baseUrl(req.get ? req : {...req,get:name=>req.headers?.[name.toLowerCase()],protocol:loopbackProxy(req.socket?.remoteAddress)&&req.headers?.['x-forwarded-proto']==='https'?'https':'http'}); } catch { return false; }
  }
  return {
    allowedOrigin,
    secureCookies: Boolean(secureCookies || configured?.protocol === 'https:'), baseUrl,
    middleware(req, res, next) {
      res.set({ 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      if (configured?.protocol === 'https:' || req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
      if (req.path === '/' || req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.path.startsWith('/api/')) return next();
      const origin = req.get('origin');
      let allowed = true;
      if (origin) {
        allowed = origins.has(origin);
        if (!allowed) { try { allowed = origin === baseUrl(req); } catch {} }
      }
      if (!allowed || req.get('sec-fetch-site') === 'cross-site')
        return res.status(403).json({ error: { code: 'invalid_origin', message: 'Доступ закрыт.' } });
      next();
    },
  };
}

export function validOccurredAt(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string' || value.length > 40) return false;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return false;
  if (value === date) return true;
  const clock = value.match(/T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!clock || +clock[1] > 23 || +clock[2] > 59 || +clock[3] > 59 || (clock[4] && (+clock[5] > 23 || +clock[6] > 59))) return false;
  return (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
}
