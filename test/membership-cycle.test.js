// Monthly credit cycles for a membership joined near the end of a month.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePayment } from '../src/services/booking.js';
import { testDb, makeClient, makeMembership } from './helpers.js';

/** Run the lazy cycle refresh for `today` and report the stored cycle start. */
function cycleOn(startedOn, today) {
  const db = testDb();
  const clientId = makeClient(db);
  const id = makeMembership(db, clientId, { unlimited: false, creditsPerMonth: 4, startedOn });
  db.prepare('UPDATE memberships SET cycle_started_on = ? WHERE id = ?').run(startedOn, id);
  resolvePayment(db, clientId, { starts_at: `${today}T10:00:00Z`, credits_required: 1 }, { now: `${today}T09:00:00Z` });
  return db.prepare('SELECT cycle_started_on FROM memberships WHERE id = ?').get(id).cycle_started_on;
}

test('a cycle anchored on the 31st returns to the 31st after February', () => {
  // Stepping each cycle from the last one clamped to 28 Feb and then kept the
  // 28th for good, quietly moving the client's refill date forward for ever.
  const cases = [
    ['2026-01-31', '2026-02-27', '2026-01-31'],
    ['2026-01-31', '2026-02-28', '2026-02-28'], // February has to clamp
    ['2026-01-31', '2026-03-30', '2026-02-28'],
    ['2026-01-31', '2026-03-31', '2026-03-31'], // and March must recover
    ['2026-01-31', '2026-04-30', '2026-04-30'],
    ['2026-01-31', '2026-05-31', '2026-05-31'],
  ];
  for (const [started, today, want] of cases) {
    assert.equal(cycleOn(started, today), want, `started ${started}, on ${today}`);
  }
});

test('cycle anchoring handles leap years, year boundaries and mid-month joins', () => {
  const cases = [
    ['2024-01-31', '2024-02-29', '2024-02-29'], // leap February
    ['2024-01-31', '2024-03-31', '2024-03-31'],
    ['2025-11-30', '2026-02-27', '2026-01-30'], // across a year boundary
    ['2025-11-30', '2026-02-28', '2026-02-28'], // 30th anchor clamps, and it is today
    ['2026-01-15', '2026-03-14', '2026-02-15'], // ordinary anchor, unaffected
    ['2026-01-15', '2026-03-15', '2026-03-15'],
  ];
  for (const [started, today, want] of cases) {
    assert.equal(cycleOn(started, today), want, `started ${started}, on ${today}`);
  }
});

test('correcting an already-drifted cycle does not refill credits mid-month', () => {
  const db = testDb();
  const clientId = makeClient(db);
  const id = makeMembership(db, clientId, { unlimited: false, creditsPerMonth: 4, startedOn: '2026-01-31' });
  // The state the old stepping logic left behind: June pinned to the 28th,
  // three of four credits already spent this cycle.
  db.prepare("UPDATE memberships SET cycle_started_on = '2026-06-28', credits_used_this_cycle = 3 WHERE id = ?")
    .run(id);

  resolvePayment(db, clientId, { starts_at: '2026-06-30T10:00:00Z', credits_required: 1 }, { now: '2026-06-30T09:00:00Z' });

  const row = db.prepare('SELECT cycle_started_on, credits_used_this_cycle FROM memberships WHERE id = ?').get(id);
  assert.equal(row.cycle_started_on, '2026-06-30', 'the drifted date should be corrected');
  assert.equal(row.credits_used_this_cycle, 3, 'same month, so credits must not be refilled');
});

test('a genuinely new month still refills credits', () => {
  const db = testDb();
  const clientId = makeClient(db);
  const id = makeMembership(db, clientId, { unlimited: false, creditsPerMonth: 4, startedOn: '2026-01-31' });
  db.prepare("UPDATE memberships SET cycle_started_on = '2026-01-31', credits_used_this_cycle = 4 WHERE id = ?")
    .run(id);

  const resolved = resolvePayment(
    db, clientId, { starts_at: '2026-03-31T10:00:00Z', credits_required: 1 }, { now: '2026-03-31T09:00:00Z' },
  );

  const row = db.prepare('SELECT cycle_started_on, credits_used_this_cycle FROM memberships WHERE id = ?').get(id);
  assert.equal(row.cycle_started_on, '2026-03-31');
  assert.equal(row.credits_used_this_cycle, 0);
  assert.equal(resolved.paidWith, 'membership', 'a refilled cycle should cover the class again');
});
