// In-memory fixed-window rate limiting on top of express-rate-limit.
//
// Deliberately simple and honest about its limits: counters live in this
// process's memory, so they reset on restart and are per-process (a
// multi-instance deployment would need a shared store). Behind a reverse
// proxy, set TRUST_PROXY=1 so the client IP is read from the first
// X-Forwarded-For hop; without it the header is ignored (spoofable) and the
// socket address is used.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

export function clientIp(req, env = process.env) {
  if (env.TRUST_PROXY) {
    const xff = req.get('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Fixed windows on an injectable clock, so tests can move time. */
class FixedWindowStore {
  constructor(now) {
    this.now = now;
    this.buckets = new Map(); // key → { window, count }
    this.localKeys = true;
  }

  init({ windowMs }) {
    this.windowMs = windowMs;
  }

  increment(key) {
    const windowId = Math.floor(this.now() / this.windowMs);
    let b = this.buckets.get(key);
    if (!b || b.window !== windowId) {
      b = { window: windowId, count: 0 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    // opportunistic cleanup so the map cannot grow without bound
    if (this.buckets.size > 10000) {
      for (const [k, v] of this.buckets) if (v.window !== windowId) this.buckets.delete(k);
    }
    return { totalHits: b.count, resetTime: new Date((windowId + 1) * this.windowMs) };
  }

  decrement(key) {
    const b = this.buckets.get(key);
    if (b && b.count > 0) b.count -= 1;
  }

  resetKey(key) {
    this.buckets.delete(key);
  }
}

/**
 * createRateLimiter({ windowMs, max, env?, now?, message?, perRoute? }) → Express middleware.
 * Keyed on client IP (IPv6 by /56, so one host can't rotate addresses) plus,
 * unless perRoute is false, the matched route pattern (so /class/1/book and
 * /class/2/book share one bucket). `now` is injectable for tests.
 */
export function createRateLimiter({
  windowMs, max, env = process.env, now = Date.now, message, perRoute = true,
} = {}) {
  const store = new FixedWindowStore(now);
  const mw = rateLimit({
    windowMs,
    limit: max,
    store,
    standardHeaders: false,
    legacyHeaders: false,
    // clientIp() does its own proxy handling; the library's checks assume req.ip.
    validate: false,
    keyGenerator(req) {
      const ip = ipKeyGenerator(clientIp(req, env));
      if (!perRoute) return ip;
      return `${ip}|${req.method} ${(req.route && req.route.path) || req.path}`;
    },
    handler(req, res) {
      // The app-wide limiter runs before the view locals exist.
      res.locals = { settings: {}, user: null, flash: null, ...res.locals };
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      res.status(429).render('error', {
        title: 'Too many requests',
        message: message || 'Too many requests from your address — please wait a few minutes and try again.',
      });
    },
  });
  mw.buckets = store.buckets; // exposed for tests/inspection
  return mw;
}
