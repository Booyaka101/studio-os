import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, makeClassType, makeInstance } from './helpers.js';
import { generateInstances, upcomingInstances } from '../src/services/schedule.js';
import { zonedToUtc, localDateStr, utcToZoned } from '../src/lib/time.js';

function makeRule(db, typeId, { weekday = 1, startTime = '09:00', capacityOverride = null, activeFrom = null, activeUntil = null } = {}) {
  return db.prepare(
    'INSERT INTO schedule_rules (class_type_id, weekday, start_time, capacity_override, active_from, active_until) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(typeId, weekday, startTime, capacityOverride, activeFrom, activeUntil).lastInsertRowid;
}

test('zonedToUtc converts Hong Kong wall time to UTC (-8h, no DST)', () => {
  const d = zonedToUtc('Asia/Hong_Kong', 2026, 8, 3, 9, 0);
  assert.equal(d.toISOString(), '2026-08-03T01:00:00.000Z');
  const p = utcToZoned('Asia/Hong_Kong', d);
  assert.equal(p.hh, 9);
  assert.equal(p.weekday, 1); // Monday
});

test('generator materializes 8 weeks of weekly instances, idempotently', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 12 });
  makeRule(db, type, { weekday: 1, startTime: '09:00' });

  const created = generateInstances(db);
  assert.equal(created, 8); // one Monday per week over 8 weeks

  const again = generateInstances(db);
  assert.equal(again, 0, 'second run creates nothing');

  const rows = db.prepare('SELECT * FROM class_instances ORDER BY starts_at').all();
  assert.equal(rows.length, 8);
  for (const r of rows) {
    const p = utcToZoned('Asia/Hong_Kong', r.starts_at);
    assert.equal(p.weekday, 1, 'lands on Monday in studio tz');
    assert.equal(p.hh, 9, 'at 09:00 studio time');
    assert.equal(r.capacity, 12, 'inherits class type capacity');
  }
});

test('capacity_override wins over class type capacity', () => {
  const db = testDb();
  const type = makeClassType(db, { capacity: 12 });
  makeRule(db, type, { capacityOverride: 4 });
  generateInstances(db);
  const row = db.prepare('SELECT capacity FROM class_instances LIMIT 1').get();
  assert.equal(row.capacity, 4);
});

test('active_from / active_until bound the generated range', () => {
  const db = testDb();
  const type = makeClassType(db);
  const tz = 'Asia/Hong_Kong';
  const today = localDateStr(tz);
  // only active for the next ~2 weeks
  const until = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  makeRule(db, type, { weekday: 3, activeFrom: today, activeUntil: until });
  generateInstances(db);
  const rows = db.prepare('SELECT starts_at FROM class_instances').all();
  assert.ok(rows.length >= 1 && rows.length <= 3, `expected ~2 instances, got ${rows.length}`);
});

test('inactive rules and inactive class types generate nothing', () => {
  const db = testDb();
  const type = makeClassType(db);
  const rule = makeRule(db, type);
  db.prepare('UPDATE schedule_rules SET active = 0 WHERE id = ?').run(rule);
  assert.equal(generateInstances(db), 0);

  db.prepare('UPDATE schedule_rules SET active = 1 WHERE id = ?').run(rule);
  db.prepare('UPDATE class_types SET active = 0 WHERE id = ?').run(type);
  assert.equal(generateInstances(db), 0);
});

test('deleting future instances then regenerating restores them (idempotent by rule+time)', () => {
  const db = testDb();
  const type = makeClassType(db);
  makeRule(db, type);
  generateInstances(db);
  db.prepare('DELETE FROM class_instances').run();
  const recreated = generateInstances(db);
  assert.equal(recreated, 8);
});

test('upcomingInstances filters by type and hides cancelled', () => {
  const db = testDb();
  const yoga = makeClassType(db, { name: 'Yoga' });
  const boxing = makeClassType(db, { name: 'Boxing' });
  makeRule(db, yoga, { weekday: 2 });
  makeRule(db, boxing, { weekday: 4 });
  generateInstances(db);

  const all = upcomingInstances(db, { days: 14 });
  const yogaOnly = upcomingInstances(db, { days: 14, classTypeId: yoga });
  assert.ok(all.length > yogaOnly.length);
  assert.ok(yogaOnly.every((r) => r.class_name === 'Yoga'));

  db.prepare("UPDATE class_instances SET status='cancelled' WHERE id = ?").run(all[0].id);
  const after = upcomingInstances(db, { days: 14 });
  assert.equal(after.length, all.length - 1);
});

test('upcomingInstances respects inclusive start and exclusive end across timestamp formats', (t) => {
  const db = testDb();
  t.after(() => db.close());
  const type = makeClassType(db);
  const first = makeInstance(db, type, { now: '2026-08-03T09:00:00Z', hoursFromNow: 0 });
  const last = makeInstance(db, type, { now: '2026-08-04T09:00:00Z', hoursFromNow: 0 });

  for (const from of ['2026-08-03T09:00:00Z', '2026-08-03T09:00:00.000Z', '2026-08-03T17:00:00+08:00']) {
    assert.deepEqual(upcomingInstances(db, { from, days: 1 }).map((r) => r.id), [first], from);
  }
  assert.deepEqual(
    upcomingInstances(db, { from: '2026-08-03T09:00:00.001Z', days: 1 }).map((r) => r.id),
    [last],
    'fractional bounds exclude the already-started class but include the last whole second'
  );
});

test('upcomingInstances matches chronological bounds across midnight and DST changes', (t) => {
  const db = testDb();
  t.after(() => db.close());
  const type = makeClassType(db);
  const starts = [
    '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-03-09T06:59:59Z',
    '2026-08-03T23:59:59Z', '2026-08-04T00:00:00Z', '2026-08-04T00:00:01Z',
    '2026-08-04T23:59:59Z', '2026-08-05T00:00:00Z',
  ];
  for (const now of starts) makeInstance(db, type, { now, hoursFromNow: 0 });

  const windows = [
    { from: '2026-08-03T23:59:59.999Z', days: 1 },
    { from: '2026-08-04T00:00:00.001Z', days: 1 },
    { from: '2026-08-04T00:00:00Z', days: 0 },
    { from: '2026-08-04T00:00:00.001Z', days: 0 },
    { from: '2026-03-08T01:59:59.999-05:00', days: 1 },
    { from: '2026-03-08T03:00:00-04:00', days: 1 },
  ];
  for (const window of windows) {
    const fromMs = Date.parse(window.from);
    const toMs = fromMs + window.days * 86400000;
    const expected = starts.filter((start) => Date.parse(start) >= fromMs && Date.parse(start) < toMs);
    assert.deepEqual(upcomingInstances(db, window).map((r) => r.starts_at), expected, JSON.stringify(window));
  }
});
