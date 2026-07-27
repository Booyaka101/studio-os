import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  testDb, makeClient, makeClassType, makeInstance, makePass, makeMembership,
  getPass, getBooking, getMembership,
} from './helpers.js';
import {
  book, cancelBooking, cancelClass, markAttendance, resolvePayment, BookingError,
} from '../src/services/booking.js';

test('booking deducts a pack credit at booking time, in the same transaction', () => {
  const db = testDb();
  const type = makeClassType(db);
  const inst = makeInstance(db, type);
  const client = makeClient(db);
  const pass = makePass(db, client, { total: 10 });

  const { booking, waitlisted } = book(db, client, inst);
  assert.equal(waitlisted, false);
  assert.equal(booking.status, 'booked');
  assert.equal(booking.paid_with, 'pack');
  assert.equal(booking.pass_id, pass);
  assert.equal(getPass(db, pass).credits_remaining, 9);
});

test('pack selection prefers the soonest-expiring pass with credits', () => {
  const db = testDb();
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 24 });
  const client = makeClient(db);
  const later = makePass(db, client, { name: 'Later', expiresOn: '2030-12-31' });
  const sooner = makePass(db, client, { name: 'Sooner', expiresOn: '2027-06-01' });
  const noExpiry = makePass(db, client, { name: 'NoExpiry', expiresOn: null });

  const { booking } = book(db, client, inst);
  assert.equal(booking.pass_id, sooner);
  assert.equal(getPass(db, sooner).credits_remaining, 9);
  assert.equal(getPass(db, later).credits_remaining, 10);
  assert.equal(getPass(db, noExpiry).credits_remaining, 10);
});

test('expired and empty packs are skipped', () => {
  const db = testDb();
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 24 });
  const client = makeClient(db);
  makePass(db, client, { name: 'Expired', expiresOn: '2020-01-01' });
  makePass(db, client, { name: 'Empty', remaining: 0 });
  const good = makePass(db, client, { name: 'Good', expiresOn: null });

  const { booking } = book(db, client, inst);
  assert.equal(booking.pass_id, good);
});

test('a pass expiring before the class date is not used for that class', () => {
  const db = testDb();
  const type = makeClassType(db);
  const client = makeClient(db);
  // class ~10 days out; pass expires in ~5 days
  const inst = makeInstance(db, type, { hoursFromNow: 240 });
  const soonExpiry = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  makePass(db, client, { name: 'TooShort', expiresOn: soonExpiry });

  const { booking } = book(db, client, inst);
  assert.equal(booking.paid_with, 'drop_in_manual');
});

test('unlimited membership outranks packs', () => {
  const db = testDb();
  const type = makeClassType(db);
  const inst = makeInstance(db, type);
  const client = makeClient(db);
  const pass = makePass(db, client);
  const mem = makeMembership(db, client, { unlimited: true });

  const { booking } = book(db, client, inst);
  assert.equal(booking.paid_with, 'membership');
  assert.equal(booking.membership_id, mem);
  assert.equal(getPass(db, pass).credits_remaining, 10);
});

test('credit membership deducts monthly credits and falls back to pack when exhausted', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 10 });
  const client = makeClient(db);
  const mem = makeMembership(db, client, { unlimited: false, creditsPerMonth: 2, startedOn: '2026-07-01' });
  const pass = makePass(db, client);

  const b1 = book(db, client, makeInstance(db, type, { hoursFromNow: 24 }));
  const b2 = book(db, client, makeInstance(db, type, { hoursFromNow: 26 }));
  assert.equal(b1.booking.paid_with, 'membership');
  assert.equal(b2.booking.paid_with, 'membership');
  assert.equal(getMembership(db, mem).credits_used_this_cycle, 2);

  const b3 = book(db, client, makeInstance(db, type, { hoursFromNow: 28 }));
  assert.equal(b3.booking.paid_with, 'pack');
  assert.equal(getPass(db, pass).credits_remaining, 9);
});

test('paused/cancelled memberships are ignored', () => {
  const db = testDb();
  const type = makeClassType(db);
  const inst = makeInstance(db, type);
  const client = makeClient(db);
  makeMembership(db, client, { status: 'paused' });
  const res = resolvePayment(db, client, db.prepare('SELECT ci.*, ct.credits_required FROM class_instances ci JOIN class_types ct ON ct.id=ci.class_type_id WHERE ci.id=?').get(inst));
  assert.equal(res.paidWith, 'drop_in');
});

test('no membership or pack falls through to drop-in', () => {
  const db = testDb();
  const type = makeClassType(db);
  const inst = makeInstance(db, type);
  const client = makeClient(db);
  const { booking } = book(db, client, inst);
  assert.equal(booking.paid_with, 'drop_in_manual');
});

test('capacity is enforced and overflow goes to the waitlist FIFO', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 2 });
  const inst = makeInstance(db, type);
  const c1 = makeClient(db); const c2 = makeClient(db);
  const c3 = makeClient(db); const c4 = makeClient(db);

  assert.equal(book(db, c1, inst).waitlisted, false);
  assert.equal(book(db, c2, inst).waitlisted, false);
  const w1 = book(db, c3, inst, { now: '2026-07-27T01:00:00Z' });
  const w2 = book(db, c4, inst, { now: '2026-07-27T02:00:00Z' });
  assert.equal(w1.waitlisted, true);
  assert.equal(w1.booking.status, 'waitlist');
  assert.equal(w2.waitlisted, true);

  const rows = db.prepare("SELECT status, COUNT(*) c FROM bookings WHERE class_instance_id=? GROUP BY status").all(inst);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.c]));
  assert.equal(byStatus.booked, 2);
  assert.equal(byStatus.waitlist, 2);
});

test('waitlisted bookings do not deduct credits until promoted', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 1 });
  const inst = makeInstance(db, type);
  const c1 = makeClient(db); const c2 = makeClient(db);
  const pass2 = makePass(db, c2);

  book(db, c1, inst);
  const { booking: wl } = book(db, c2, inst);
  assert.equal(wl.status, 'waitlist');
  assert.equal(getPass(db, pass2).credits_remaining, 10);
});

test('duplicate booking for the same class is rejected; rebooking after cancel works', () => {
  const db = testDb();
  const type = makeClassType(db);
  const inst = makeInstance(db, type);
  const client = makeClient(db);
  const { booking } = book(db, client, inst);
  assert.throws(() => book(db, client, inst), (e) => e instanceof BookingError && e.code === 'already_booked');
  cancelBooking(db, booking.id);
  const again = book(db, client, inst);
  assert.equal(again.booking.status, 'booked');
});

test('booking a cancelled or past class is rejected', () => {
  const db = testDb();
  const type = makeClassType(db);
  const client = makeClient(db);
  const past = makeInstance(db, type, { hoursFromNow: -2 });
  assert.throws(() => book(db, client, past), (e) => e.code === 'in_past');

  const inst = makeInstance(db, type);
  db.prepare("UPDATE class_instances SET status='cancelled' WHERE id=?").run(inst);
  assert.throws(() => book(db, client, inst), (e) => e.code === 'class_cancelled');
});

test('early cancel refunds the pack credit', () => {
  const db = testDb({ cancellation_window_hours: '12' });
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  const client = makeClient(db);
  const pass = makePass(db, client);
  const { booking } = book(db, client, inst);
  assert.equal(getPass(db, pass).credits_remaining, 9);

  const res = cancelBooking(db, booking.id); // 48h out > 12h window
  assert.equal(res.late, false);
  assert.equal(res.refunded, true);
  assert.equal(getPass(db, pass).credits_remaining, 10);
  assert.equal(getBooking(db, booking.id).status, 'cancelled');
});

test('late cancel forfeits the credit under the default policy', () => {
  const db = testDb({ cancellation_window_hours: '12' });
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 3 }); // inside 12h window
  const client = makeClient(db);
  const pass = makePass(db, client);
  const { booking } = book(db, client, inst);

  const res = cancelBooking(db, booking.id);
  assert.equal(res.late, true);
  assert.equal(res.refunded, false);
  assert.equal(getPass(db, pass).credits_remaining, 9); // forfeited
});

test('late cancel refunds when policy is set to refund', () => {
  const db = testDb({ cancellation_window_hours: '12', late_cancel_policy: 'refund' });
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 3 });
  const client = makeClient(db);
  const pass = makePass(db, client);
  const { booking } = book(db, client, inst);

  const res = cancelBooking(db, booking.id);
  assert.equal(res.late, true);
  assert.equal(res.refunded, true);
  assert.equal(getPass(db, pass).credits_remaining, 10);
});

test('membership credit is returned on eligible cancellation', () => {
  const db = testDb();
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  const client = makeClient(db);
  const mem = makeMembership(db, client, { unlimited: false, creditsPerMonth: 4, startedOn: '2026-07-01' });
  const { booking } = book(db, client, inst);
  assert.equal(getMembership(db, mem).credits_used_this_cycle, 1);
  cancelBooking(db, booking.id);
  assert.equal(getMembership(db, mem).credits_used_this_cycle, 0);
});

test('cancellation promotes the first waitlisted booking (FIFO) and deducts their credit', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 1 });
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  const c1 = makeClient(db); const c2 = makeClient(db); const c3 = makeClient(db);
  const pass2 = makePass(db, c2);

  const b1 = book(db, c1, inst, { now: '2026-07-26T01:00:00Z' });
  const w2 = book(db, c2, inst, { now: '2026-07-26T02:00:00Z' });
  const w3 = book(db, c3, inst, { now: '2026-07-26T03:00:00Z' });

  const res = cancelBooking(db, b1.booking.id);
  assert.ok(res.promoted, 'someone was promoted');
  assert.equal(res.promoted.id, w2.booking.id, 'FIFO: earliest waitlist first');
  assert.equal(res.promoted.status, 'booked');
  assert.equal(res.promoted.paid_with, 'pack');
  assert.equal(getPass(db, pass2).credits_remaining, 9);
  assert.equal(getBooking(db, w3.booking.id).status, 'waitlist');
});

test('cancelling a waitlist booking does not promote or refund', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 1 });
  const inst = makeInstance(db, type);
  const c1 = makeClient(db); const c2 = makeClient(db);
  book(db, c1, inst);
  const { booking: wl } = book(db, c2, inst);
  const res = cancelBooking(db, wl.id);
  assert.equal(res.refunded, false);
  assert.equal(res.promoted, null);
});

test('promotion re-resolves payment if the waitlisted client acquired a membership meanwhile', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 1 });
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  const c1 = makeClient(db); const c2 = makeClient(db);
  const b1 = book(db, c1, inst);
  book(db, c2, inst); // waitlisted as drop_in
  makeMembership(db, c2, { unlimited: true });

  const res = cancelBooking(db, b1.booking.id);
  assert.equal(res.promoted.paid_with, 'membership');
});

test('cancelClass refunds all confirmed bookings regardless of window and cancels the instance', () => {
  const db = testDb({ cancellation_window_hours: '12' });
  const type = makeClassType(db, { capacity: 2 });
  const inst = makeInstance(db, type, { hoursFromNow: 2 }); // inside window — still refunds
  const c1 = makeClient(db); const c2 = makeClient(db); const c3 = makeClient(db);
  const p1 = makePass(db, c1); const p2 = makePass(db, c2);
  book(db, c1, inst); book(db, c2, inst);
  const wl = book(db, c3, inst);

  const { affected } = cancelClass(db, inst);
  assert.equal(affected.length, 3);
  assert.equal(getPass(db, p1).credits_remaining, 10);
  assert.equal(getPass(db, p2).credits_remaining, 10);
  assert.equal(getBooking(db, wl.booking.id).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM class_instances WHERE id=?').get(inst).status, 'cancelled');
});

test('attendance marking: attended, no_show, and cancelled bookings free capacity accounting correctly', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 2 });
  const inst = makeInstance(db, type);
  const c1 = makeClient(db); const c2 = makeClient(db); const c3 = makeClient(db);
  const b1 = book(db, c1, inst);
  const b2 = book(db, c2, inst);
  markAttendance(db, b1.booking.id, 'attended');
  markAttendance(db, b2.booking.id, 'no_show');
  // attended/no_show still occupy the class — next booking waitlists
  const b3 = book(db, c3, inst);
  assert.equal(b3.waitlisted, true);
  assert.throws(() => markAttendance(db, b3.booking.id, 'attended'), (e) => e.code === 'not_found');
});

test('multi-credit classes deduct and refund credits_required', () => {
  const db = testDb();
  const type = makeClassType(db, { credits: 2 });
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  const client = makeClient(db);
  const pass = makePass(db, client, { total: 5 });
  const { booking } = book(db, client, inst);
  assert.equal(getPass(db, pass).credits_remaining, 3);
  cancelBooking(db, booking.id);
  assert.equal(getPass(db, pass).credits_remaining, 5);
});

test('a pass with fewer credits than required is skipped', () => {
  const db = testDb();
  const type = makeClassType(db, { credits: 2 });
  const inst = makeInstance(db, type);
  const client = makeClient(db);
  makePass(db, client, { total: 5, remaining: 1 });
  const { booking } = book(db, client, inst);
  assert.equal(booking.paid_with, 'drop_in_manual');
});

test('capacity race: concurrent-style bookings never exceed capacity (transactional)', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 5 });
  const inst = makeInstance(db, type);
  const clients = Array.from({ length: 20 }, () => makeClient(db));
  for (const c of clients) book(db, c, inst);
  const booked = db.prepare(
    "SELECT COUNT(*) c FROM bookings WHERE class_instance_id=? AND status='booked'"
  ).get(inst).c;
  const wait = db.prepare(
    "SELECT COUNT(*) c FROM bookings WHERE class_instance_id=? AND status='waitlist'"
  ).get(inst).c;
  assert.equal(booked, 5);
  assert.equal(wait, 15);
});
