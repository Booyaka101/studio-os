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
- [x] `scripts/seed.mjs` (demo studio: 3 instructors, 4 class types, 8 weekly rules → 64 instances, products, 4 clients w/ passes+membership, 2×2 demo bookings; refuses non-empty DB without --force; login owner@example.com/studio-demo), Dockerfile (node:22-slim, VOLUME /app/data) + .dockerignore + docker-compose.yml (studio-data volume), README.md (quickstart Docker+Node, Mindbody migration guide, Stripe guide, limitations, roadmap), CHANGELOG.md. NOTE: docker build not run at the time — verified later, see the hardening pass below.

## Self-verification (2026-07-27, item 8) — ALL PASSED
Live server on PORT=3791, DB_PATH=data/verify-studio.db (deleted after), Node v22.18.0:
1. `npm test` → **67/67 pass, 0 fail** (booking 21 + schedule 10 + web 17 + importer 8 + stripe 11).
2. Fresh empty DB boot: `GET /` → 302 `Location: /setup`; `GET /setup` → 200 "Welcome to Studio OS".
3. `node scripts/seed.mjs` → 3 instructors, 4 class types, 8 rules → 64 instances, products, 4 clients, 4 demo bookings. Re-run without `--force` correctly refused (exit 1).
4. Seeded boot: `GET /` → 200; schedule lists 20 upcoming instances (Vinyasa/Pilates/Handstand/Yin) with "spots left".
5. Booking round-trip: `POST /class/33/book` (new guest, waiver_agree=1) → 200 "Booked"; duplicate re-POST did NOT create a second booking; admin login (`POST /admin/login` → 302) then `GET /admin/instances/33` roster shows the client, paid_with `drop_in_manual` ("pay at studio"), check-in buttons.
6. Magic-link cancel: `POST /magic-link` → on-screen `/me?token=...` (SMTP off); `GET /me?token` → 200 listing the booking; `POST /me/cancel/5` → 302 back to /me, flash "cancelled", list empty; DB row: status='cancelled', cancelled_at set; roster no longer shows the client.
7. Server stopped cleanly. NOT verified: `docker build` ($0/no-network guardrail — Dockerfile untested).

## Hardening pass (2026-07-28)
- [x] CSRF protection: random per-session token stored in the cookie-session, exposed as `res.locals.csrfToken`, hidden `_csrf` input added to all 36 POST forms (public book/buy/magic-link, /me cancel, setup, admin login/logout and every admin form). Middleware in `src/app.js` rejects POST/PUT/DELETE/PATCH with missing/mismatched token (403, timing-safe compare; `x-csrf-token` header also accepted). `/webhooks/stripe` exempt (mounted before the session layer + explicit path guard; authenticated by Stripe signature instead). Tests updated to cookie agents + `csrfToken()` helper; 2 explicit tests (no/wrong token → 403 + nothing written; valid token works; webhook stays exempt). 69/69 green.

- [x] Docker verification (2026-07-28, Docker Desktop 4.44.2 / Engine 28.3.2, linux/amd64): `docker compose build` succeeded first try — `node:22-slim` + better-sqlite3 prebuilt glibc binary, no python3/make/g++ stage needed. Found + fixed a real compose bug: `environment:` list containing only comments parses as null → "must be a mapping" validation error; block now fully commented in mapping form. Live run: `docker compose up -d` → `GET /` 302 `/setup` on fresh volume → completed setup wizard via curl (CSRF cookie+token round-trip) → admin one-off class POST → public schedule renders Yoga Flow → guest booking on `/class/1` → "Booked"; booking POST without CSRF token → 403 in-container. `docker compose down -v` clean. Verified commands recorded in README.
- [x] Rate limiting: `src/lib/ratelimit.js` (dependency-free in-memory fixed window, key = client IP + matched route pattern, injectable clock, X-Forwarded-For honored only when `TRUST_PROXY` env set). Wired in `src/app.js` before the CSRF check: `/magic-link` 5/15min, `/admin/login` 10/15min, booking/buy POSTs (`/class/:id/book`, `/buy/pack/:id`, `/buy/membership/:id`) 30/15min → friendly 429 + Retry-After. 4 tests in `test/ratelimit.test.js` (trigger, window reset via fake clock — no sleeps, XFF spoof/trust behavior). README limitations updated → new Security section; `TRUST_PROXY` documented in `.env.example`. 73/73 green. NOTE: limiter is per-process and resets on restart (documented).

## v0.2.0 — instructor logins (2026-07-28) — SHIPPED, ALL VERIFIED
- [x] Migration v2 (`src/db/002-instructor-role.sql`): users role CHECK rebuilt to allow 'instructor' (owner/staff untouched — verified against a real v1 file DB: both users kept, v2 applied, instructor insert OK); new `instructor_class_assignments (instructor_id→users, class_id→class_instances, PK both, ON DELETE CASCADE)` + idx_ica_class.
- [x] Guards (`src/services/auth.js`): `requireAdmin` (admin router; instructor → 403, anon → 302 login), `requireInstructor` (instructor portal; admins → /admin). Login (`src/routes/auth.js`): `/login` aliases `/admin/login`; POST redirects by role (instructor → /instructor/schedule).
- [x] Instructor portal (`src/routes/instructor.js` + `views/instructor/{schedule,roster}.ejs`): schedule (assigned classes from studio-local today, sorted by date), roster (attendee + status, 'attended' displayed as 'checked-in'; NO client emails exposed), POST checkin (assignment-guarded, booking must belong to the class, reuses `markAttendance`).
- [x] Admin UI: Instructors page gains logins section; `/admin/instructors/new` (GET+POST, password ≥8, UNIQUE-email friendly error); `/admin/instructors/:id/classes` checkbox assignment (rewrites only the displayed upcoming window; past assignments kept). Routes declared BEFORE `POST /instructors/:id` so 'new' isn't captured as :id.
- [x] Tests: `test/instructor.test.js` (8) + 4 new view-integrity tests = **110/110 green** (`npm test`).
- [x] Live E2E on PORT=3799 (seeded DB, curl, then killed + scratch DB deleted): owner created kim@studio.test, assigned class 25 of 2; instructor login → 302 /instructor/schedule; schedule showed only Mat Pilates #25; /admin → 403; roster #9 → 403; roster #25 → 200; check-in booking 1 → Alice Chan 'checked-in'; check-in on #9 → 403; POST without CSRF → 403.
- [x] package.json 0.2.0, CHANGELOG 0.2.0 entry, README (feature bullet + walkthrough step 6, roadmap line removed).

## Next
- v0.2.0 complete. Optional future: docker rebuild sanity check on next release; screenshots of the instructor portal for README.

## Pragmatic choices where SPEC is silent (decided, noted per guardrail)
- **pack_products table added** (schema v1): SPEC's buy page sells "class packs" but only defines per-client `passes`; a purchasable catalogue was needed. Same for drop-in pending payments → `payments.status` ('paid'|'pending').
- **Waitlisted bookings do not deduct credits**; deduction happens at promotion (same tx), payment re-resolved at promotion time.
- **Drop-in online**: booking is created immediately; payment row pending; Stripe checkout (kind=drop_in metadata) marks it paid via webhook. Capacity is not held hostage to checkout completion.
- **Sessions**: cookie-session (signed cookie) — SPEC allows either. app_secret auto-generated into settings, overridable via APP_SECRET env.
- ~~No CSRF tokens in v0.1 (same-site=lax cookies); listed in README limitations.~~ Added in the 2026-07-28 hardening pass (session-bound `_csrf` token, no csurf dependency).
- `npm test` uses glob `"test/*.test.js"` — `node --test test/` breaks under Git Bash path mangling on Windows.

## How to resume
- `cd D:\Repos\ideas\studio-os && npm test` (expect 31+ green) and `git log --oneline` to see where things stand.
- Work top-down through “Next”. Commit after each numbered item at minimum.
- Guardrails: stay inside this folder; $0 / no network at boot or in tests; no remotes/publishing; Stripe/SMTP env-gated.
