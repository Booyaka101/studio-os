# Changelog

## Unreleased

- **Docker verified end-to-end**: `docker compose build && up -d` → setup
  wizard, admin class creation, public schedule and a guest booking all
  exercised against the running container, then `down -v`. Fixed
  `docker-compose.yml`: an `environment:` key with only commented entries is
  invalid YAML for compose ("must be a mapping") — the example block is now
  fully commented out.
- **Rate limiting**: dependency-free in-memory fixed-window limiter
  (`src/lib/ratelimit.js`), keyed per client IP + route: magic-link requests
  5/15 min, admin login 10/15 min, public booking/buy POSTs 30/15 min;
  friendly 429 with `Retry-After`. `X-Forwarded-For` is honored only when
  `TRUST_PROXY` is set. Single-process counters (reset on restart) — see the
  new README Security section.
- **CSRF protection**: session-bound random token (stored in the signed
  cookie-session, no deprecated `csurf` dependency), hidden `_csrf` input on
  every state-changing form (public booking/buy/magic-link, client cancel,
  setup wizard, admin login and all admin forms); POST/PUT/DELETE/PATCH
  without a valid token → 403. `/webhooks/stripe` exempt (Stripe-signature
  verified raw body instead). `x-csrf-token` header accepted as an
  alternative to the form field.

## 0.1.0 — 2026-07-27

First release. Single-studio, self-hosted, bring-your-own Stripe.

- Public schedule (14-day view, filters), class pages, guest booking with
  waiver capture, returning-client booking by email
- Booking engine: membership → soonest-expiring pack → drop-in payment
  resolution; atomic capacity; FIFO waitlist with auto-promotion;
  cancellation-window refunds; late-cancel forfeit/refund policy; attendance
- Client self-service via HMAC magic links (no client passwords): view
  upcoming bookings, cancel within policy
- Rolling 8-week schedule materialization from weekly rules (boot + daily +
  on change), one-off classes, class cancellation with notify + refund
- Admin: dashboard (today's rosters, week revenue, expiring passes), class
  types / instructors / weekly rules CRUD, roster check-in/no-show/walk-in,
  client profiles (manual passes, memberships, payments, waiver, magic link),
  products (packs + membership plans), revenue & attendance reports + CSV,
  settings, SQLite backup via `VACUUM INTO`
- Buy page: Stripe Checkout for packs (one-time) and memberships
  (subscription) with signature-verified, idempotent webhook fulfillment;
  full manual "pay at studio" fallback when Stripe is unconfigured
- Email via SMTP, or `data/outbox/*.eml` + on-screen links when unset
- Mindbody CSV importer (clients + pricing options): CLI + admin page,
  JSON column mapping with defaults, dry-run, idempotent by email
- Seed script (`npm run seed`), Dockerfile + docker-compose, PWA manifest +
  service worker, vendored htmx/Pico.css (no CDN), 67 tests (no network)

