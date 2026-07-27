-- Studio OS schema v1. All timestamps are UTC ISO-8601 strings.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','staff')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS instructors (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  bio    TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS class_types (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  duration_min        INTEGER NOT NULL DEFAULT 60,
  capacity            INTEGER NOT NULL DEFAULT 10,
  drop_in_price_cents INTEGER NOT NULL DEFAULT 0,
  credits_required    INTEGER NOT NULL DEFAULT 1,
  color               TEXT NOT NULL DEFAULT '#4f7cac',
  active              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS schedule_rules (
  id                INTEGER PRIMARY KEY,
  class_type_id     INTEGER NOT NULL REFERENCES class_types(id),
  instructor_id     INTEGER REFERENCES instructors(id),
  weekday           INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday
  start_time        TEXT NOT NULL,                                    -- 'HH:MM' studio-local
  capacity_override INTEGER,
  active_from       TEXT,                                             -- 'YYYY-MM-DD' local
  active_until      TEXT,
  active            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS class_instances (
  id            INTEGER PRIMARY KEY,
  class_type_id INTEGER NOT NULL REFERENCES class_types(id),
  instructor_id INTEGER REFERENCES instructors(id),
  rule_id       INTEGER REFERENCES schedule_rules(id),
  starts_at     TEXT NOT NULL,               -- UTC ISO
  duration_min  INTEGER NOT NULL DEFAULT 60,
  capacity      INTEGER NOT NULL DEFAULT 10,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  notes         TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_instance_rule_start
  ON class_instances(rule_id, starts_at) WHERE rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_instances_starts ON class_instances(starts_at);

CREATE TABLE IF NOT EXISTS clients (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone            TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  waiver_signed_at TEXT,
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','self')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS passes (
  id               INTEGER PRIMARY KEY,
  client_id        INTEGER NOT NULL REFERENCES clients(id),
  name             TEXT NOT NULL,
  credits_total    INTEGER NOT NULL,
  credits_remaining INTEGER NOT NULL,
  expires_on       TEXT,                     -- 'YYYY-MM-DD' local date, inclusive
  price_paid_cents INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('purchase','import','manual')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_passes_client ON passes(client_id);

CREATE TABLE IF NOT EXISTS membership_plans (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  price_cents       INTEGER NOT NULL DEFAULT 0,
  interval          TEXT NOT NULL DEFAULT 'month',
  unlimited         INTEGER NOT NULL DEFAULT 1,
  credits_per_month INTEGER,
  stripe_price_id   TEXT,
  active            INTEGER NOT NULL DEFAULT 1
);

-- Purchasable class-pack products shown on the buy page (SPEC is silent on a
-- pack catalogue; passes are per-client, so products live here).
CREATE TABLE IF NOT EXISTS pack_products (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  credits         INTEGER NOT NULL,
  price_cents     INTEGER NOT NULL DEFAULT 0,
  validity_days   INTEGER,                    -- NULL = never expires
  stripe_price_id TEXT,
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS memberships (
  id                      INTEGER PRIMARY KEY,
  client_id               INTEGER NOT NULL REFERENCES clients(id),
  plan_id                 INTEGER REFERENCES membership_plans(id),
  plan_name               TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  started_on              TEXT NOT NULL,     -- 'YYYY-MM-DD'
  renews_on               TEXT,
  stripe_subscription_id  TEXT,
  unlimited               INTEGER NOT NULL DEFAULT 1,
  credits_per_month       INTEGER,
  credits_used_this_cycle INTEGER NOT NULL DEFAULT 0,
  cycle_started_on        TEXT               -- 'YYYY-MM-DD'
);
CREATE INDEX IF NOT EXISTS idx_memberships_client ON memberships(client_id);

CREATE TABLE IF NOT EXISTS bookings (
  id                INTEGER PRIMARY KEY,
  class_instance_id INTEGER NOT NULL REFERENCES class_instances(id),
  client_id         INTEGER NOT NULL REFERENCES clients(id),
  status            TEXT NOT NULL DEFAULT 'booked'
                    CHECK (status IN ('booked','waitlist','cancelled','attended','no_show')),
  paid_with         TEXT NOT NULL
                    CHECK (paid_with IN ('pack','membership','drop_in_online','drop_in_manual','comp')),
  pass_id           INTEGER REFERENCES passes(id),
  membership_id     INTEGER REFERENCES memberships(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  cancelled_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_active
  ON bookings(class_instance_id, client_id) WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_bookings_instance ON bookings(class_instance_id);
CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_id);

CREATE TABLE IF NOT EXISTS payments (
  id                INTEGER PRIMARY KEY,
  client_id         INTEGER REFERENCES clients(id),
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'HKD',
  method            TEXT NOT NULL CHECK (method IN ('stripe','cash','fps','other')),
  reference         TEXT NOT NULL DEFAULT '',
  what              TEXT NOT NULL CHECK (what IN ('drop_in','pack','membership')),
  status            TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','pending')),
  stripe_session_id TEXT UNIQUE,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY,
  who    TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
