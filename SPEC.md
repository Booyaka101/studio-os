# Studio OS — self-hosted studio management ("the Mindbody escape hatch")

Open-source, self-hosted booking/membership/class-pack management for boutique studios
(yoga, pilates, martial arts, climbing, dance, small gyms). The structural wedge no SaaS
rival can copy: **payments run on the operator's OWN Stripe account** — we never touch the
money, charge no processing markup, no per-booking fees, no contracts.

Target user: a studio owner currently paying Mindbody $139–599/mo + ~3.5% forced processing.
Deployment target: one Docker container (or `npm start`) on a $5 VPS or a spare machine.

## v0.1 scope (MUST all work)

### Stack
- Node 20+, Express, better-sqlite3 (WAL mode), server-rendered EJS templates + HTMX
  (vendored locally, NO CDN at runtime), vendored Pico.css + one small custom stylesheet.
  No frontend build step. No paid APIs. Everything works offline except Stripe/SMTP.
- `node:test` + supertest for tests. Dockerfile + docker-compose.yml. `.env` config
  (dotenv), `data/studio.db` SQLite file.
- License MIT. Repo layout: `src/` (server), `src/routes/`, `src/db/` (schema+migrations+queries),
  `src/services/`, `views/`, `public/` (css/js/manifest), `test/`, `scripts/` (seed, import),
  `README.md`, `CHANGELOG.md`.

### Domain model (SQLite tables)
- `settings` (key/value): studio name, timezone (default Asia/Hong_Kong), currency (default HKD),
  cancellation window hours (default 12), waiver markdown text, booking policy flags.
- `users`: operator/staff logins (email, argon2/bcrypt hash, role: owner|staff). Session auth
  (cookie, SQLite session store or signed cookie). First-run setup wizard creates the owner.
- `instructors`: name, bio, active.
- `class_types`: name, description, duration min, default capacity, drop-in price cents,
  credits required (default 1), color.
- `schedule_rules`: weekly recurring template (class_type, instructor, weekday, start time,
  capacity override, active from/until) → materialized into `class_instances` on a rolling
  8-week horizon (idempotent generator run at boot + daily + on rule change).
- `class_instances`: datetime, class_type, instructor, capacity, status (scheduled|cancelled),
  notes. One-off instances can be created directly.
- `clients`: name, email (unique), phone, notes, waiver_signed_at, source (manual|import|self).
- `passes` (class packs): client, name, credits_total, credits_remaining, expires_on,
  price_paid_cents, source (purchase|import|manual).
- `memberships`: client, plan name, status (active|paused|cancelled), started_on, renews_on,
  stripe_subscription_id nullable, unlimited flag or credits/month.
- `membership_plans`: name, price cents, interval (month), unlimited or N credits/month,
  stripe_price_id nullable.
- `bookings`: class_instance, client, status (booked|waitlist|cancelled|attended|no_show),
  paid_with (pack|membership|drop_in_online|drop_in_manual|comp), pass_id nullable,
  created_at, cancelled_at. Unique (class_instance, client) among non-cancelled.
- `payments`: client, amount cents, currency, method (stripe|cash|fps|other), reference,
  what (drop_in|pack|membership), stripe_session_id nullable, created_at.
- `audit_log`: who, action, entity, at — append-only, for operator trust.

### Booking rules (core logic — must be tested)
- Book with: active membership (unlimited or monthly credits) → else pack with credits
  (soonest-expiring first) → else drop-in (Stripe checkout if configured, else "pay at studio"
  which records a pending manual payment).
- Capacity enforced atomically (SQLite transaction). Full class → waitlist (FIFO). A
  cancellation auto-promotes the first waitlisted booking and (if SMTP on) emails them.
- Cancel ≥ cancellation-window hours before start → credit refunded to pack / no charge.
  Late cancel → configurable: forfeit credit (default) or refund. No-show marking by staff.
- Credits are deducted at booking time, refunded on eligible cancellation, in the same
  transaction as the booking row.

### Public site (no login needed)
- `/` public schedule: next 14 days, filter by class type/instructor, studio branding from settings.
- Class page → "Book" → enter name+email (or returning-client email). First booking shows the
  waiver (markdown rendered) with required checkbox; `waiver_signed_at` stored.
- Client self-service via signed magic links (HMAC token in email / shown on screen when SMTP
  is off): view own upcoming bookings, cancel within policy. NO client passwords in v0.1.
- Buy page: class packs and membership plans. With Stripe configured → Stripe Checkout
  (packs = one-time, memberships = subscription); webhook `/webhooks/stripe` (signature-verified)
  fulfills: creates pass / activates membership + payment row. Without Stripe → instructions page
  ("pay at studio / FPS") and operator activates manually.
- PWA: manifest.json + minimal service worker (cache static assets), mobile-first layout.

### Admin (login required)
- Dashboard: today's classes with live roster counts, week revenue total, expiring passes list.
- Schedule management: CRUD class types, instructors, weekly rules, one-off classes,
  cancel a class (auto-notifies + refunds credits of all bookings).
- Roster per class: check-in (attended), no-show, add walk-in client, see paid_with per booking.
- Clients: search, profile (bookings, passes, memberships, payments), add pass/membership
  manually, record manual payment, edit waiver status, notes.
- Reports: revenue by month (table), attendance by class type, CSV export of any report.
- Settings: studio profile, currency, cancellation window, waiver text (markdown editor),
  Stripe keys status (from env, read-only display), SMTP status, backup button (downloads
  a copy of studio.db via SQLite `VACUUM INTO`).

### Mindbody CSV importer
`scripts/import-mindbody.mjs` + admin UI page. Accepts the standard Mindbody exports:
- Clients export (First Name, Last Name, Email, Phone, ...) → clients.
- "Pricing options"/pass export (Client, Pricing Option, Remaining, Expiration, ...) → passes.
Column mapping via a JSON mapping file with sane defaults; unknown columns ignored; dry-run
mode prints what would be created; idempotent by email (re-running updates, never duplicates).
Ship a `test/fixtures/mindbody-*.csv` set of realistic fixtures (invented data, realistic shape).

### Email (optional)
SMTP via nodemailer, env-configured. When unset: emails are written to `data/outbox/` as .eml
files and magic links are surfaced in the UI (so everything is testable without SMTP).
Templates: booking confirmation, cancellation, waitlist promotion, magic link.

### Stripe (optional, BYO account)
Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY. When unset, all
purchase flows fall back to manual/"pay at studio" and the admin sees a "Stripe not connected"
hint. When set (test mode is fine): packs via Checkout one-time, memberships via Checkout
subscription using `membership_plans.stripe_price_id` (admin field to paste a Price ID),
webhook fulfillment, and payment rows with the Stripe session id. NEVER store card data.
Write the integration against the official `stripe` npm package; all Stripe calls isolated in
`src/services/stripe.js` and fully mockable — tests must not hit the network.

### Non-negotiables
- First-run experience: `npm install && npm start` → setup wizard (studio name, owner account,
  timezone/currency) → seeded example class types optional. `npm run seed` creates a demo studio.
- Every core booking rule covered by tests (capacity race, waitlist promotion, credit
  deduct/refund, late-cancel forfeit, importer idempotency, webhook fulfillment with mocked
  Stripe, magic-link auth). `npm test` green.
- No network calls at boot or in tests. No telemetry. No mocks/placeholders in shipped code paths.
- All timestamps stored UTC, rendered in the studio timezone.
- README: 5-minute quickstart (Docker + bare Node), Mindbody migration guide (step-by-step:
  which exports to download, how to run the importer), Stripe setup guide, screenshots section
  placeholder, honest v0.1 limitations list, roadmap (multi-location, branded PWA, SMS).

### Out of scope for v0.1 (list in README roadmap; do NOT build now)
Multi-location, staff payroll, retail/POS, gift cards, video/livestream, marketing automation,
native apps, per-instructor payouts, GDPR export tooling, i18n (English UI only, but no
hardcoded currency symbols — use the currency setting).

## Definition of done for v0.1
`npm test` green; `npm start` boots on a clean machine; a full manual walkthrough works:
setup wizard → create class type + weekly rule → instances appear on public schedule →
guest books with waiver → operator sells a 10-pack manually → client books with credit →
cancel refunds credit → roster check-in → revenue report shows the payments → Mindbody
fixture import creates clients+passes → magic link lets the client cancel a booking.
Docker build succeeds. README complete.
