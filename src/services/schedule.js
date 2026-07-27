// Rolling instance generator: materializes schedule_rules into class_instances
// over a horizon (default 8 weeks). Idempotent — keyed on (rule_id, starts_at).

import { getSetting } from '../db/index.js';
import { zonedToUtc, localDateStr, addDays, weekdayOf } from '../lib/time.js';

/**
 * Generate class_instances for all active rules from today through
 * today + horizonWeeks*7 (studio-local days). Never touches existing rows.
 * Returns number of instances created.
 */
export function generateInstances(db, { now } = {}) {
  const tz = getSetting(db, 'timezone', 'Asia/Hong_Kong');
  const horizonWeeks = Number(getSetting(db, 'horizon_weeks', '8'));
  const today = localDateStr(tz, now || new Date());
  const rules = db.prepare(
    `SELECT sr.*, ct.capacity AS type_capacity, ct.duration_min
     FROM schedule_rules sr JOIN class_types ct ON ct.id = sr.class_type_id
     WHERE sr.active = 1 AND ct.active = 1`
  ).all();
  if (!rules.length) return 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO class_instances
     (class_type_id, instructor_id, rule_id, starts_at, duration_min, capacity, status)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled')`
  );
  let created = 0;
  db.transaction(() => {
    for (const rule of rules) {
      const [hh, mm] = rule.start_time.split(':').map(Number);
      for (let i = 0; i < horizonWeeks * 7; i++) {
        const day = addDays(today, i);
        if (weekdayOf(day) !== rule.weekday) continue;
        if (rule.active_from && day < rule.active_from) continue;
        if (rule.active_until && day > rule.active_until) continue;
        const [y, m, d] = day.split('-').map(Number);
        const startsAt = zonedToUtc(tz, y, m, d, hh, mm).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const r = insert.run(
          rule.class_type_id, rule.instructor_id, rule.id, startsAt,
          rule.duration_min, rule.capacity_override ?? rule.type_capacity
        );
        created += r.changes;
      }
    }
  })();
  return created;
}

/** Upcoming scheduled instances joined with type + instructor, for listings. */
export function upcomingInstances(db, { days = 14, from, classTypeId, instructorId, includeCancelled = false } = {}) {
  const fromIso = from || new Date().toISOString();
  const toIso = new Date(new Date(fromIso).getTime() + days * 86400000).toISOString();
  let sql = `
    SELECT ci.*, ct.name AS class_name, ct.color, ct.credits_required, ct.drop_in_price_cents,
           ct.description AS class_description, i.name AS instructor_name,
           (SELECT COUNT(*) FROM bookings b WHERE b.class_instance_id = ci.id
              AND b.status IN ('booked','attended','no_show')) AS booked_count,
           (SELECT COUNT(*) FROM bookings b WHERE b.class_instance_id = ci.id
              AND b.status = 'waitlist') AS waitlist_count
    FROM class_instances ci
    JOIN class_types ct ON ct.id = ci.class_type_id
    LEFT JOIN instructors i ON i.id = ci.instructor_id
    WHERE ci.starts_at >= ? AND ci.starts_at < ?`;
  const params = [fromIso, toIso];
  if (!includeCancelled) sql += " AND ci.status = 'scheduled'";
  if (classTypeId) { sql += ' AND ci.class_type_id = ?'; params.push(classTypeId); }
  if (instructorId) { sql += ' AND ci.instructor_id = ?'; params.push(instructorId); }
  sql += ' ORDER BY ci.starts_at';
  return db.prepare(sql).all(...params);
}
