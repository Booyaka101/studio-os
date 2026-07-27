// Client self-service via signed magic links. No passwords.
import { Router } from 'express';
import { verifyMagicToken, makeMagicToken } from '../services/auth.js';
import { cancelBooking, BookingError } from '../services/booking.js';
import { getSetting, audit } from '../db/index.js';
import { emails } from '../services/mailer.js';

export default function meRoutes(services) {
  const { db, mailer } = services;
  const r = Router();

  function requireClient(req, res) {
    const token = req.query.token || req.body.token;
    const clientId = verifyMagicToken(db, token);
    if (!clientId) {
      res.status(401).render('public/magic_request', {
        title: 'My bookings', sent: false, magicUrl: null,
        error: 'That link is invalid or has expired. Request a new one below.',
      });
      return null;
    }
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!client) {
      res.status(401).render('public/magic_request', {
        title: 'My bookings', sent: false, magicUrl: null, error: 'Unknown client.',
      });
      return null;
    }
    return { client, token };
  }

  r.get('/', (req, res) => {
    const auth = requireClient(req, res);
    if (!auth) return;
    const { client, token } = auth;
    const nowIso = new Date().toISOString();
    const bookings = db.prepare(
      `SELECT b.*, ci.starts_at, ci.status AS instance_status, ct.name AS class_name,
              i.name AS instructor_name
       FROM bookings b
       JOIN class_instances ci ON ci.id = b.class_instance_id
       JOIN class_types ct ON ct.id = ci.class_type_id
       LEFT JOIN instructors i ON i.id = ci.instructor_id
       WHERE b.client_id = ? AND b.status IN ('booked','waitlist') AND ci.starts_at >= ?
       ORDER BY ci.starts_at`
    ).all(client.id, nowIso);
    const passes = db.prepare(
      'SELECT * FROM passes WHERE client_id = ? AND credits_remaining > 0 ORDER BY expires_on IS NULL, expires_on'
    ).all(client.id);
    const memberships = db.prepare(
      "SELECT * FROM memberships WHERE client_id = ? AND status = 'active'"
    ).all(client.id);
    const windowHours = Number(getSetting(db, 'cancellation_window_hours', '12'));
    res.render('public/me', {
      title: 'My bookings', client, token, bookings, passes, memberships, windowHours,
    });
  });

  r.post('/cancel/:bookingId', (req, res) => {
    const auth = requireClient(req, res);
    if (!auth) return;
    const { client, token } = auth;
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.bookingId);
    if (!booking || booking.client_id !== client.id) {
      return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
    }
    try {
      const result = cancelBooking(db, booking.id);
      audit(db, client.email, 'client_cancel', `booking:${booking.id}`);
      const studio = getSetting(db, 'studio_name', 'the studio');
      const inst = result.instance;
      const when = res.locals.fmtDt(inst.starts_at);
      mailer.send({
        to: client.email,
        ...emails.cancellation({ studio, clientName: client.name, className: inst.class_name, when, refunded: result.refunded }),
      });
      if (result.promoted) {
        const promotedClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.promoted.client_id);
        const magicUrl = `${services.baseUrl(req)}/me?token=${makeMagicToken(db, promotedClient.id)}`;
        mailer.send({
          to: promotedClient.email,
          ...emails.waitlistPromotion({ studio, clientName: promotedClient.name, className: inst.class_name, when, magicUrl }),
        });
      }
      req.session.flash = result.refunded
        ? 'Booking cancelled — your credit has been returned.'
        : (result.late ? 'Booking cancelled. This was a late cancellation, so the credit was not returned.' : 'Booking cancelled.');
    } catch (err) {
      if (err instanceof BookingError) {
        req.session.flash = err.message;
      } else {
        throw err;
      }
    }
    res.redirect(`/me?token=${encodeURIComponent(token)}`);
  });

  return r;
}
