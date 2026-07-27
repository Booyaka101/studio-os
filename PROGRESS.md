# Studio OS — build progress

Authoritative spec: `SPEC.md`. Node used: **v22.18.0** (better-sqlite3 11.x prebuilt, SQLite 3.49.2 — no compile needed).
Run tests: `npm test`. Start: `npm start` (PORT env, default 3000).

## Done
- [x] Scaffold: package.json (studio-os, MIT, type:module), deps installed, htmx 1.9.12 + pico.css 2.0.6 vendored in `public/vendor/` (commit 2cb4364)
- [x] DB: `src/db/schema.sql` (migration v1), `src/db/index.js` (WAL, FK on, migrations, settings helpers, audit), `src/lib/time.js` (Intl-based tz conversion, no tz lib)
- [x] Core booking engine `src/services/booking.js`: payment resolution (membership → soonest-expiring pack → drop-in), atomic capacity via transactions, waitlist FIFO + promotion (re-resolves payment at promotion), cancellation window refund / late-cancel forfeit (policy setting), cancelClass full refund, attendance marking
- [x] Rolling schedule generator `src/services/schedule.js` (8-week horizon, idempotent on (rule_id, starts_at))
- [x] Tests: 31 passing (`test/booking.test.js`, `test/schedule.test.js`) covering every SPEC booking rule incl. capacity race, FIFO promotion, credit deduct/refund, soonest-expiring pack selection, tz materialization (commit fadbc47)
- [x] Auth service (bcryptjs + HMAC magic-link tokens), mailer (SMTP or `data/outbox/*.eml` fallback + all templates), Stripe service (isolated, injectable client, idempotent fulfillment by `payments.stripe_session_id` UNIQUE)
- [x] App skeleton `src/app.js` (webhook raw-body mounted before parsers, cookie-session, setup gate, view locals) + `src/server.js` (boot + daily generator)
- [x] Routes: setup wizard, staff login/logout, webhooks, public (schedule/class/book with waiver/buy/magic-link request), `src/routes/me.js` (magic-link self-service + cancel)
- [x] Admin routes + full EJS UI (public + admin), PWA assets (manifest, sw.js, custom.css), 16 supertest web tests (commits 897ad8e, 7449c52)
- [x] Mindbody importer: `src/services/importer.js` (CSV parser, mapping defaults + overrides, idempotent by email), `scripts/import-mindbody.mjs` CLI (--clients/--passes/--mapping/--db/--dry-run), realistic fixtures `test/fixtures/mindbody-{clients,passes}.csv` (edge cases: missing email, quoted commas, uppercase email, malformed row), admin `/admin/import` page wired, 8 importer tests + 1 web test (56 total green)

- [x] Stripe webhook tests `test/stripe.test.js` (11 tests, mock client, no network): signature reject, pack/membership/drop-in fulfillment, replay idempotency, subscription cancel, 500-retry on unknown product, checkout session params (67 total green)
- [x] `scripts/seed.mjs` (demo studio: 3 instructors, 4 class types, 8 weekly rules → 64 instances, products, 4 clients w/ passes+membership, 2×2 demo bookings; refuses non-empty DB without --force; login owner@example.com/studio-demo), Dockerfile (node:22-slim, VOLUME /app/data) + .dockerignore + docker-compose.yml (studio-data volume), README.md (quickstart Docker+Node, Mindbody migration guide, Stripe guide, limitations, roadmap), CHANGELOG.md. NOTE: docker build not run locally ($0/no-network guardrail) — image untested.

## Next (exact order)
7. `scripts/seed.mjs`, Dockerfile, docker-compose.yml, README.md, CHANGELOG.md
8. Self-verify: npm test green; boot on free PORT; curl setup → schedule → booking round-trip with seeded data; record transcript summary here

## Pragmatic choices where SPEC is silent (decided, noted per guardrail)
- **pack_products table added** (schema v1): SPEC's buy page sells "class packs" but only defines per-client `passes`; a purchasable catalogue was needed. Same for drop-in pending payments → `payments.status` ('paid'|'pending').
- **Waitlisted bookings do not deduct credits**; deduction happens at promotion (same tx), payment re-resolved at promotion time.
- **Drop-in online**: booking is created immediately; payment row pending; Stripe checkout (kind=drop_in metadata) marks it paid via webhook. Capacity is not held hostage to checkout completion.
- **Sessions**: cookie-session (signed cookie) — SPEC allows either. app_secret auto-generated into settings, overridable via APP_SECRET env.
- No CSRF tokens in v0.1 (same-site=lax cookies); listed in README limitations.
- `npm test` uses glob `"test/*.test.js"` — `node --test test/` breaks under Git Bash path mangling on Windows.

## How to resume
- `cd D:\Repos\ideas\studio-os && npm test` (expect 31+ green) and `git log --oneline` to see where things stand.
- Work top-down through “Next”. Commit after each numbered item at minimum.
- Guardrails: stay inside this folder; $0 / no network at boot or in tests; no remotes/publishing; Stripe/SMTP env-gated.
