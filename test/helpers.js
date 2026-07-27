// Shared test fixtures: in-memory DB with a small studio.
import { openDb, setSetting } from '../src/db/index.js';

export function testDb(settings = {}) {
  const db = openDb(':memory:');
  setSetting(db, 'studio_name', 'Test Studio');
  setSetting(db, 'timezone', 'Asia/Hong_Kong');
  setSetting(db, 'setup_complete', '1');
  for (const [k, v] of Object.entries(settings)) setSetting(db, k, v);
  return db;
}

export function makeClient(db, { name = 'Alice Wong', email = `c${Math.random().toString(36).slice(2)}@t.test`, waiver = true } = {}) {
  const info = db.prepare(
    'INSERT INTO clients (name, email, waiver_signed_at, source) VALUES (?, ?, ?, ?)'
  ).run(name, email, waiver ? new Date().toISOString() : null, 'manual');
  return info.lastInsertRowid;
}

export function makeClassType(db, { name = 'Yoga', capacity = 3, credits = 1, price = 15000, duration = 60 } = {}) {
  return db.prepare(
    'INSERT INTO class_types (name, duration_min, capacity, drop_in_price_cents, credits_required) VALUES (?, ?, ?, ?, ?)'
  ).run(name, duration, capacity, price, credits).lastInsertRowid;
}

/** A class instance N hours from `now` (default: from real now). */
export function makeInstance(db, typeId, { hoursFromNow = 48, capacity, now } = {}) {
  const base = now ? new Date(now).getTime() : Date.now();
  const startsAt = new Date(base + hoursFromNow * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const cap = capacity ?? db.prepare('SELECT capacity FROM class_types WHERE id = ?').get(typeId).capacity;
  return db.prepare(
    "INSERT INTO class_instances (class_type_id, starts_at, duration_min, capacity, status) VALUES (?, ?, 60, ?, 'scheduled')"
  ).run(typeId, startsAt, cap).lastInsertRowid;
}

export function makePass(db, clientId, { name = '10 Pack', total = 10, remaining = total, expiresOn = null, source = 'manual' } = {}) {
  return db.prepare(
    'INSERT INTO passes (client_id, name, credits_total, credits_remaining, expires_on, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(clientId, name, total, remaining, expiresOn, source).lastInsertRowid;
}

export function makeMembership(db, clientId, { unlimited = true, creditsPerMonth = null, status = 'active', startedOn = '2026-01-01' } = {}) {
  return db.prepare(
    `INSERT INTO memberships (client_id, plan_name, status, started_on, unlimited, credits_per_month, cycle_started_on)
     VALUES (?, 'Test Plan', ?, ?, ?, ?, ?)`
  ).run(clientId, status, startedOn, unlimited ? 1 : 0, creditsPerMonth, startedOn).lastInsertRowid;
}

export const getPass = (db, id) => db.prepare('SELECT * FROM passes WHERE id = ?').get(id);
export const getBooking = (db, id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
export const getMembership = (db, id) => db.prepare('SELECT * FROM memberships WHERE id = ?').get(id);
