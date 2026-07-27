import express from 'express';
import cookieSession from 'cookie-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, allSettings } from './db/index.js';
import { formatInTz } from './lib/time.js';
import { createMailer } from './services/mailer.js';
import { createStripeService } from './services/stripe.js';
import setupRoutes from './routes/setup.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import meRoutes from './routes/me.js';
import adminRoutes from './routes/admin.js';
import webhookRoutes from './routes/webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the Express app. Dependencies are injectable for tests:
 * createApp({ db, mailer?, stripeService?, env? })
 */
export function createApp({ db, mailer, stripeService, env = process.env }) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');

  const services = {
    db,
    mailer: mailer || createMailer({ env }),
    stripe: stripeService || createStripeService({ env }),
    env,
    baseUrl(req) {
      return env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    },
  };
  app.locals.services = services;

  // Stripe webhook needs the raw body for signature verification — mount
  // before any body parser.
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }), webhookRoutes(services));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(cookieSession({
    name: 'studio_session',
    keys: [getSetting(db, 'app_secret', 'dev-secret')],
    sameSite: 'lax',
    httpOnly: true,
    maxAge: 30 * 24 * 3600000,
  }));

  // View locals: settings + formatting helpers, refreshed per request.
  app.use((req, res, next) => {
    const s = allSettings(db);
    res.locals.settings = s;
    res.locals.tz = s.timezone || 'Asia/Hong_Kong';
    res.locals.currency = s.currency || 'HKD';
    res.locals.fmtDt = (iso, opts) => formatInTz(res.locals.tz, iso, opts);
    res.locals.fmtMoney = (cents) => new Intl.NumberFormat('en', {
      style: 'currency', currency: res.locals.currency, minimumFractionDigits: 0,
    }).format((cents || 0) / 100);
    res.locals.user = req.session && req.session.userId
      ? db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(req.session.userId)
      : null;
    res.locals.stripeConfigured = services.stripe.configured;
    res.locals.smtpConfigured = services.mailer.smtpConfigured;
    res.locals.flash = req.session ? req.session.flash : null;
    if (req.session) delete req.session.flash;
    next();
  });

  // CSRF protection: a random per-session token lives in the signed cookie
  // session and must be echoed back (hidden `_csrf` input or `x-csrf-token`
  // header) on every state-changing request. /webhooks/stripe is exempt — it
  // is mounted before this middleware and authenticated by Stripe signature.
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrf;
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
    if (req.path.startsWith('/webhooks/')) return next();
    const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
    const a = Buffer.from(String(sent));
    const b = Buffer.from(req.session.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).render('error', {
        title: 'Session expired',
        message: 'Your form session expired or the security token was missing. Please go back, refresh the page, and try again.',
      });
    }
    next();
  });

  // First-run gate: until setup completes, everything routes to the wizard.
  app.use((req, res, next) => {
    const done = getSetting(db, 'setup_complete', '0') === '1';
    if (!done && !req.path.startsWith('/setup') && !req.path.startsWith('/vendor')
        && !req.path.startsWith('/css') && !req.path.startsWith('/js')) {
      return res.redirect('/setup');
    }
    if (done && req.path.startsWith('/setup')) return res.redirect('/');
    next();
  });

  app.use('/setup', setupRoutes(services));
  app.use('/', authRoutes(services));
  app.use('/admin', adminRoutes(services));
  app.use('/me', meRoutes(services));
  app.use('/', publicRoutes(services));

  // 404 + error handler
  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).render('error', { title: 'Error', message: err.expose ? err.message : 'Something went wrong.' });
  });

  return app;
}
