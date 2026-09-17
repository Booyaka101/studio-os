# Changelog

## Unreleased

- **Security: magic links were emailed as `http://` behind a reverse proxy.**
  `TRUST_PROXY` was read by the rate limiter but Express's own `trust proxy`
  setting was never applied, so with TLS terminating at the proxy
  `req.protocol` read `http` and every emailed link carried its 7-day auth
  token over plaintext. Stripe's success/cancel redirects had the same scheme.
  Setting `TRUST_PROXY=1` now also makes the app honour `X-Forwarded-Proto`,
  and the session cookie picks up its `Secure` flag over https (it stays off
  on plain http, so local dev is unchanged). If you run behind Caddy/nginx/
  Traefik, set `TRUST_PROXY=1` or pin `BASE_URL` to your https origin.
- **Security: the staff login could enumerate accounts.** `authenticate()`
  returned early for an unknown email and skipped bcrypt entirely, answering
  ~3000x faster than for a real one. Both paths now do one bcrypt comparison.
  `app_secret` is also no longer reachable from templates.
- **Membership credit cycles drifted for end-of-month joins.** Cycles were
  stepped from the previous cycle, so February's day clamp compounded: a
  membership joined on the 31st became the 28th and stayed there. Cycles now
  anchor on the join date (31 Jan, 28 Feb, 31 Mar). Correcting an
  already-drifted membership does not refill its credits mid-month.
- **Dependencies**: stripe 16 → 22, nodemailer 9 → 10 (clears
  GHSA-8m3c-c648-2xjj), marked → 18.0.13. `npm audit` is clean.
- **Tests**: 110 → 123. The Stripe and mailer suites only ever ran against a
  mock client and the offline outbox, so neither package was imported under
  test and a major bump could not have failed CI. New tests exercise the real
  packages, including webhook signature verification.
- README and SPEC said Node 20+; `engines` requires >=22.

## 0.2.0 — 2026-07-28

- **Instructor logins.** New `instructor` user role alongside the existing
  owner/staff (admin) roles — existing accounts are untouched by the
  migration (v2 rebuilds the `users` CHECK; SQLite cannot alter one in
  place). Instructors sign in on the same staff login form (`/login` now
  aliases `/admin/login`) and land on their own portal:
  - `GET /instructor/schedule` — the classes they are assigned to, from
    today onward, sorted by date
  - `GET /instructor/classes/:id/roster` — attendee list with status
    (booked / checked-in / no-show / cancelled), class time and capacity;
    client emails are *not* exposed to instructors
  - `POST /instructor/classes/:id/checkin/:booking_id` — check an attendee
    in (same `markAttendance` business logic as the admin roster)
  - Route guards: every `/admin/*` route returns **403** for instructor
    accounts; rosters and check-in return **403** for classes the
    instructor is not assigned to.
- **Admin: instructor account management.** The Instructors page gains an
  "Instructor logins" section; `/admin/instructors/new` creates an account
  (name, email, password ≥ 8 chars, role `instructor`);
  `/admin/instructors/:id/classes` assigns/unassigns upcoming classes via
  checkboxes (many-to-many `instructor_class_assignments` table, cascade
  on account/instance deletion; past assignments are left untouched).
- 12 new tests (guards, scoping, check-in, admin CRUD, migration; the four
  new views covered by the integrity suite) — 110 total, no network.
  Upgrade path verified against a real v1 database file.

## 0.1.0-hardening — 2026-07-28

- **Fix: CSRF inputs injected inside attribute values.** The hardening pass had
  inserted the hidden `_csrf` input at the wrong offset in 22 forms whose
  `action` contained an EJS expression, corrupting the submit URL and leaking
  markup as visible text. All POST forms now carry the token immediately after
  the form open tag, enforced by a new static views-integrity test suite
  (`test/views.test.js`), and verified with a real in-browser form submission.
- **README screenshots**: 8 captured views of the seeded demo studio (public
  schedule/booking/buy, admin dashboard/schedule/roster/client/reports).
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

