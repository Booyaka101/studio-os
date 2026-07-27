// Tiny in-memory fixed-window rate limiter. No dependencies.
//
// Deliberately simple and honest about its limits: counters live in this
// process's memory, so they reset on restart and are per-process (a
// multi-instance deployment would need a shared store). Behind a reverse
// proxy, set TRUST_PROXY=1 so the client IP is read from the first
// X-Forwarded-For hop; without it the header is ignored (spoofable) and the
// socket address is used.

export function clientIp(req, env = process.env) {
  if (env.TRUST_PROXY) {
    const xff = req.get('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * createRateLimiter({ windowMs, max, env?, now?, message? }) → Express middleware.
 * Fixed window keyed on client IP + matched route pattern (so /class/1/book
 * and /class/2/book share one bucket). `now` is injectable for tests.
 */
export function createRateLimiter({ windowMs, max, env = process.env, now = Date.now, message } = {}) {
  const buckets = new Map(); // key → { window, count }
  const mw = (req, res, next) => {
    const windowId = Math.floor(now() / windowMs);
    const route = (req.route && req.route.path) || req.path;
    const key = `${clientIp(req, env)}|${req.method} ${route}`;
    let b = buckets.get(key);
    if (!b || b.window !== windowId) {
      b = { window: windowId, count: 0 };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).render('error', {
        title: 'Too many requests',
        message: message || 'Too many requests from your address — please wait a few minutes and try again.',
      });
    }
    // opportunistic cleanup so the map cannot grow without bound
    if (buckets.size > 10000) {
      for (const [k, v] of buckets) if (v.window !== windowId) buckets.delete(k);
    }
    next();
  };
  mw.buckets = buckets; // exposed for tests/inspection
  return mw;
}
