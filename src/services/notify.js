// Emails that more than one route sends.
import { getSetting } from '../db/index.js';
import { makeMagicToken } from './auth.js';
import { emails } from './mailer.js';

/** Tell a client they've come off the waitlist, with a link to manage the booking. */
export function notifyPromoted(services, req, res, booking, inst) {
  const { db, mailer } = services;
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(booking.client_id);
  if (!client) return;
  const magicUrl = `${services.baseUrl(req)}/me?token=${makeMagicToken(db, client.id)}`;
  mailer.send({
    to: client.email,
    ...emails.waitlistPromotion({
      studio: getSetting(db, 'studio_name', 'the studio'), clientName: client.name,
      className: inst.class_name, when: res.locals.fmtDt(inst.starts_at), magicUrl,
    }),
  });
}
