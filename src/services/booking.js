// Core booking engine. Pure DB logic — no email/HTTP side effects. Callers get
// back event objects (e.g. promoted bookings) and decide whether to notify.
// All mutating operations run inside a single better-sqlite3 transaction, so
// capacity checks and credit movements are atomic.

import { getSetting } from '../db/index.js';
import { localDateStr, hoursBetween, addDays } from '../lib/time.js';

export class BookingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const OCCUPYING = "('booked','attended','no_show')"; // statuses that hold a spot

function bookedCount(db, instanceId) {
  return db.prepare(
    `SELECT COUNT(*) c FROM bookings WHERE class_instance_id = ? AND status IN ${OCCUPYING}`
  ).get(instanceId).c;
}

/** Lazy monthly-credit cycle reset for a credit-based membership. */
function refreshMembershipCycle(db, m, todayLocal) {
  if (m.unlimited || !m.credits_per_month) return m;
  let cycleStart = m.cycle_started_on || m.started_on;
  let changed = false;
  // advance cycle start by whole months until it is the current cycle
  while (addMonths(cycleStart, 1) <= todayLocal) {
    cycleStart = addMonths(cycleStart, 1);
    changed = true;
  }
  if (changed) {
    db.prepare('UPDATE memberships SET cycle_started_on = ?, credits_used_this_cycle = 0 WHERE id = ?')
      .run(cycleStart, m.id);
    m = { ...m, cycle_started_on: cycleStart, credits_used_this_cycle: 0 };
  } else if (!m.cycle_started_on) {
    db.prepare('UPDATE memberships SET cycle_started_on = ? WHERE id = ?').run(cycleStart, m.id);
    m = { ...m, cycle_started_on: cycleStart };
  }
  return m;
}

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, lastDay));
  return dt.toISOString().slice(0, 10);
}

/**
 * Decide how a client would pay for a class, per spec priority:
 * active membership → soonest-expiring pack with credits → drop-in.
 * Returns { paidWith, passId?, membershipId? } without mutating anything.
 */
export function resolvePayment(db, clientId, instance, { now } = {}) {
  const tz = getSetting(db, 'timezone', 'Asia/Hong_Kong');
  const nowIso = now || new Date().toISOString();
  const today = localDateStr(tz, nowIso);
  const classDay = localDateStr(tz, instance.starts_at);
  const creditsNeeded = instance.credits_required ?? 1;

  // 1. active membership
  const memberships = db.prepare(
    "SELECT * FROM memberships WHERE client_id = ? AND status = 'active' ORDER BY unlimited DESC, id"
  ).all(clientId);
  for (let m of memberships) {
    if (m.unlimited) return { paidWith: 'membership', membershipId: m.id };
    m = refreshMembershipCycle(db, m, today);
    if ((m.credits_per_month || 0) - m.credits_used_this_cycle >= creditsNeeded) {
      return { paidWith: 'membership', membershipId: m.id };
    }
  }

  // 2. pack with credits, soonest-expiring first (NULL expiry sorts last),
  //    must not be expired before the class date
  const pass = db.prepare(
    `SELECT * FROM passes
     WHERE client_id = ? AND credits_remaining >= ?
       AND (expires_on IS NULL OR expires_on >= ?)
     ORDER BY (expires_on IS NULL), expires_on, id LIMIT 1`
  ).get(clientId, creditsNeeded, classDay > today ? classDay : today);
  if (pass) return { paidWith: 'pack', passId: pass.id };

  // 3. drop-in (caller decides online vs manual)
  return { paidWith: 'drop_in' };
}

function deduct(db, resolution, creditsNeeded) {
  if (resolution.paidWith === 'pack') {
    const r = db.prepare(
      'UPDATE passes SET credits_remaining = credits_remaining - ? WHERE id = ? AND credits_remaining >= ?'
    ).run(creditsNeeded, resolution.passId, creditsNeeded);
    if (r.changes !== 1) throw new BookingError('no_credits', 'Pass no longer has enough credits');
  } else if (resolution.paidWith === 'membership') {
    db.prepare(
      'UPDATE memberships SET credits_used_this_cycle = credits_used_this_cycle + ? WHERE id = ? AND unlimited = 0'
    ).run(creditsNeeded, resolution.membershipId);
  }
}

function refund(db, booking, creditsNeeded) {
  if (booking.paid_with === 'pack' && booking.pass_id) {
    db.prepare('UPDATE passes SET credits_remaining = credits_remaining + ? WHERE id = ?')
      .run(creditsNeeded, booking.pass_id);
  } else if (booking.paid_with === 'membership' && booking.membership_id) {
    db.prepare(
      'UPDATE memberships SET credits_used_this_cycle = MAX(0, credits_used_this_cycle - ?) WHERE id = ? AND unlimited = 0'
    ).run(creditsNeeded, booking.membership_id);
  }
}

function loadInstance(db, instanceId) {
  const inst = db.prepare(
    `SELECT ci.*, ct.credits_required, ct.name AS class_name, ct.drop_in_price_cents
     FROM class_instances ci JOIN class_types ct ON ct.id = ci.class_type_id
     WHERE ci.id = ?`
  ).get(instanceId);
  if (!inst) throw new BookingError('not_found', 'Class not found');
  return inst;
}

/**
 * Book a client into a class instance.
 * options: { paidWith } to force ('drop_in_online'|'drop_in_manual'|'comp'),
 *          { now } ISO override for tests, { allowPast } for admin walk-ins.
 * Returns the booking row plus { waitlisted: bool }.
 */
export function book(db, clientId, instanceId, options = {}) {
  const nowIso = options.now || new Date().toISOString();
  return db.transaction(() => {
    const inst = loadInstance(db, instanceId);
    if (inst.status !== 'scheduled') throw new BookingError('class_cancelled', 'Class is cancelled');
    if (!options.allowPast && inst.starts_at <= nowIso) {
      throw new BookingError('in_past', 'Class has already started');
    }
    const dup = db.prepare(
      "SELECT id FROM bookings WHERE class_instance_id = ? AND client_id = ? AND status != 'cancelled'"
    ).get(instanceId, clientId);
    if (dup) throw new BookingError('already_booked', 'Client already has a booking for this class');

    const creditsNeeded = inst.credits_required ?? 1;
    let resolution;
    if (options.paidWith && options.paidWith !== 'auto') {
      resolution = { paidWith: options.paidWith };
    } else {
      resolution = resolvePayment(db, clientId, inst, { now: nowIso });
      if (resolution.paidWith === 'drop_in') {
        resolution.paidWith = options.dropInMode === 'online' ? 'drop_in_online' : 'drop_in_manual';
      }
    }

    const full = bookedCount(db, instanceId) >= inst.capacity;
    const status = full ? 'waitlist' : 'booked';
    // Credits are deducted at booking time for confirmed spots only; waitlisted
    // bookings deduct when promoted (spec is silent — pragmatic choice).
    if (status === 'booked') deduct(db, resolution, creditsNeeded);

    const info = db.prepare(
      `INSERT INTO bookings (class_instance_id, client_id, status, paid_with, pass_id, membership_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(instanceId, clientId, status, resolution.paidWith,
      status === 'booked' ? resolution.passId ?? null : null,
      status === 'booked' ? resolution.membershipId ?? null : null,
      nowIso);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
    return { booking, waitlisted: full, instance: inst };
  })();
}

/** Promote the first FIFO waitlisted booking of an instance. Internal + reused by cancelBooking. */
function promoteNext(db, inst, nowIso) {
  const next = db.prepare(
    "SELECT * FROM bookings WHERE class_instance_id = ? AND status = 'waitlist' ORDER BY created_at, id LIMIT 1"
  ).get(inst.id);
  if (!next) return null;
  const creditsNeeded = inst.credits_required ?? 1;
  // Re-resolve payment at promotion time (their pass may have expired meanwhile).
  let resolution = resolvePayment(db, next.client_id, inst, { now: nowIso });
  if (resolution.paidWith === 'drop_in') resolution.paidWith = 'drop_in_manual';
  deduct(db, resolution, creditsNeeded);
  db.prepare(
    'UPDATE bookings SET status = ?, paid_with = ?, pass_id = ?, membership_id = ? WHERE id = ?'
  ).run('booked', resolution.paidWith, resolution.passId ?? null, resolution.membershipId ?? null, next.id);
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(next.id);
}

/**
 * Cancel a booking. Within the cancellation window → credit refunded; late →
 * per policy (default forfeit). Auto-promotes the first waitlisted booking.
 * Returns { booking, refunded, late, promoted } (promoted = booking row or null).
 */
export function cancelBooking(db, bookingId, options = {}) {
  const nowIso = options.now || new Date().toISOString();
  return db.transaction(() => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) throw new BookingError('not_found', 'Booking not found');
    if (!['booked', 'waitlist'].includes(booking.status)) {
      throw new BookingError('not_cancellable', `Cannot cancel a ${booking.status} booking`);
    }
    const inst = loadInstance(db, booking.class_instance_id);
    const windowHours = Number(getSetting(db, 'cancellation_window_hours', '12'));
    const policy = getSetting(db, 'late_cancel_policy', 'forfeit');
    const hoursToStart = hoursBetween(nowIso, inst.starts_at);
    const late = hoursToStart < windowHours;
    const wasBooked = booking.status === 'booked';
    const creditsNeeded = inst.credits_required ?? 1;

    let refunded = false;
    if (wasBooked && (!late || policy === 'refund' || options.forceRefund)) {
      refund(db, booking, creditsNeeded);
      refunded = booking.paid_with === 'pack' || booking.paid_with === 'membership';
    }
    db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
      .run(nowIso, bookingId);

    // A freed confirmed spot promotes the first waitlisted booking.
    let promoted = null;
    if (wasBooked && bookedCount(db, inst.id) < inst.capacity) {
      promoted = promoteNext(db, inst, nowIso);
    }
    return { booking: { ...booking, status: 'cancelled', cancelled_at: nowIso }, refunded, late, promoted, instance: inst };
  })();
}

/** Staff roster actions. */
export function markAttendance(db, bookingId, status) {
  if (!['attended', 'no_show', 'booked'].includes(status)) {
    throw new BookingError('bad_status', 'Invalid attendance status');
  }
  const r = db.prepare(
    "UPDATE bookings SET status = ? WHERE id = ? AND status IN ('booked','attended','no_show')"
  ).run(status, bookingId);
  if (r.changes !== 1) throw new BookingError('not_found', 'Booking not found or not markable');
}

/**
 * Cancel a whole class: refund credits of every confirmed booking (always,
 * regardless of window — the studio cancelled), cancel all active bookings,
 * mark the instance cancelled. Returns affected bookings for notification.
 */
export function cancelClass(db, instanceId, options = {}) {
  const nowIso = options.now || new Date().toISOString();
  return db.transaction(() => {
    const inst = loadInstance(db, instanceId);
    if (inst.status === 'cancelled') throw new BookingError('already_cancelled', 'Class already cancelled');
    const creditsNeeded = inst.credits_required ?? 1;
    const affected = db.prepare(
      "SELECT * FROM bookings WHERE class_instance_id = ? AND status IN ('booked','waitlist')"
    ).all(instanceId);
    for (const b of affected) {
      if (b.status === 'booked') refund(db, b, creditsNeeded);
      db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
        .run(nowIso, b.id);
    }
    db.prepare("UPDATE class_instances SET status = 'cancelled' WHERE id = ?").run(instanceId);
    return { instance: inst, affected };
  })();
}
