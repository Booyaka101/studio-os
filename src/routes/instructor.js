import { Router } from 'express';
import { requireInstructor } from '../services/auth.js';
import { getSetting, audit } from '../db/index.js';
import { markAttendance, BookingError } from '../services/booking.js';
import { localDateStr, zonedToUtc } from '../lib/time.js';

export default function instructorRoutes(services) {
  const { db } = services;
  const r = Router();
  r.use(requireInstructor);

  const isAssigned = (instructorId, classId) => !!db.prepare(
    'SELECT 1 FROM instructor_class_assignments WHERE instructor_id = ? AND class_id = ?'
  ).get(instructorId, classId);

  // From studio-local midnight today, so a class stays visible for check-in
  // while it is running, not just before it starts.
  const todayStartUtc = () => {
    const tz = getSetting(db, 'timezone', 'Asia/Hong_Kong');
    const [y, m, d] = localDateStr(tz).split('-').map(Number);
    return zonedToUtc(tz, y, m, d, 0, 0).toISOString();
  };

  // ---------------------------------------------------------------- schedule
  r.get('/schedule', (req, res) => {
    const classes = db.prepare(
      `SELECT ci.*, ct.name AS class_name, ct.color,
              (SELECT COUNT(*) FROM bookings b WHERE b.class_instance_id = ci.id
                 AND b.status IN ('booked','attended','no_show')) AS booked_count
       FROM instructor_class_assignments ica
       JOIN class_instances ci ON ci.id = ica.class_id
       JOIN class_types ct ON ct.id = ci.class_type_id
       WHERE ica.instructor_id = ? AND ci.starts_at >= ?
       ORDER BY ci.starts_at`
    ).all(req.session.userId, todayStartUtc());
    res.render('instructor/schedule', { title: 'My schedule', classes });
  });

  // ------------------------------------------------------------------ roster
  r.get('/classes/:id/roster', (req, res) => {
    if (!isAssigned(req.session.userId, Number(req.params.id))) {
      return res.status(403).render('error', {
        title: 'Forbidden', message: 'You are not assigned to this class.',
      });
    }
    const inst = db.prepare(
      `SELECT ci.*, ct.name AS class_name FROM class_instances ci
       JOIN class_types ct ON ct.id = ci.class_type_id WHERE ci.id = ?`
    ).get(req.params.id);
    if (!inst) return res.status(404).render('error', { title: 'Not found', message: 'Class not found.' });
    const roster = db.prepare(
      `SELECT b.*, c.name AS client_name FROM bookings b JOIN clients c ON c.id = b.client_id
       WHERE b.class_instance_id = ? AND b.status IN ('booked','attended','no_show','cancelled')
       ORDER BY b.status = 'cancelled', b.created_at`
    ).all(inst.id);
    res.render('instructor/roster', { title: `Roster — ${inst.class_name}`, inst, roster });
  });

  // ----------------------------------------------------------------- check-in
  r.post('/classes/:id/checkin/:booking_id', (req, res) => {
    const classId = Number(req.params.id);
    if (!isAssigned(req.session.userId, classId)) {
      return res.status(403).render('error', {
        title: 'Forbidden', message: 'You are not assigned to this class.',
      });
    }
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.booking_id);
    if (!booking || booking.class_instance_id !== classId) {
      return res.status(404).render('error', { title: 'Not found', message: 'Booking not found in this class.' });
    }
    try {
      markAttendance(db, booking.id, 'attended');
      audit(db, res.locals.user.email, 'booking_attended', `booking:${booking.id}`);
    } catch (err) {
      if (!(err instanceof BookingError)) throw err;
      req.session.flash = err.message;
    }
    res.redirect(`/instructor/classes/${classId}/roster`);
  });

  return r;
}
