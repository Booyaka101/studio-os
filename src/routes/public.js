import { Router } from 'express';
import { marked } from 'marked';
import { getSetting, audit } from '../db/index.js';
import { upcomingInstances } from '../services/schedule.js';
import { book, resolvePayment, BookingError } from '../services/booking.js';
import { makeMagicToken } from '../services/auth.js';
import { emails } from '../services/mailer.js';

function findOrCreateClient(db, name, email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  let client = db.prepare('SELECT * FROM clients WHERE email = ?').get(cleanEmail);
  if (!client) {
    const info = db.prepare(
      "INSERT INTO clients (name, email, source) VALUES (?, ?, 'self')"
    ).run(String(name || cleanEmail.split('@')[0]).trim(), cleanEmail);
    client = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
  } else if (name && name.trim() && client.name !== name.trim()) {
    // keep the freshest name the client typed
    db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(name.trim(), client.id);
    client.name = name.trim();
  }
  return client;
}

function loadInstanceFull(db, id) {
  return db.prepare(
    `SELECT ci.*, ct.name AS class_name, ct.description AS class_description, ct.color,
            ct.credits_required, ct.drop_in_price_cents, i.name AS instructor_name,
            (SELECT COUNT(*) FROM bookings b WHERE b.class_instance_id = ci.id
               AND b.status IN ('booked','attended','no_show')) AS booked_count
     FROM class_instances ci
     JOIN class_types ct ON ct.id = ci.class_type_id
     LEFT JOIN instructors i ON i.id = ci.instructor_id
     WHERE ci.id = ?`
  ).get(id);
}

export default function publicRoutes(services) {
  const { db, mailer } = services;
  const r = Router();

  // Public schedule, next 14 days, filterable.
  r.get('/', (req, res) => {
    const classTypeId = Number(req.query.type) || null;
    const instructorId = Number(req.query.instructor) || null;
    const instances = upcomingInstances(db, { days: 14, classTypeId, instructorId });
    const types = db.prepare('SELECT * FROM class_types WHERE active = 1 ORDER BY name').all();
    const instructors = db.prepare('SELECT * FROM instructors WHERE active = 1 ORDER BY name').all();
    res.render('public/schedule', {
      title: 'Schedule', instances, types, instructors,
      filterType: classTypeId, filterInstructor: instructorId,
    });
  });

  r.get('/class/:id', (req, res) => {
    const inst = loadInstanceFull(db, req.params.id);
    if (!inst || inst.status !== 'scheduled') {
      return res.status(404).render('error', { title: 'Not found', message: 'Class not found.' });
    }
    res.render('public/class', {
      title: inst.class_name, inst,
      full: inst.booked_count >= inst.capacity,
      waiverHtml: marked.parse(getSetting(db, 'waiver_markdown', '')),
      error: null, form: {},
    });
  });

  r.post('/class/:id/book', async (req, res) => {
    const inst = loadInstanceFull(db, req.params.id);
    if (!inst || inst.status !== 'scheduled') {
      return res.status(404).render('error', { title: 'Not found', message: 'Class not found.' });
    }
    const { name, email, waiver_agree } = req.body;
    const renderErr = (error, status = 400) => res.status(status).render('public/class', {
      title: inst.class_name, inst, full: inst.booked_count >= inst.capacity,
      waiverHtml: marked.parse(getSetting(db, 'waiver_markdown', '')),
      error, form: { name, email },
    });

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return renderErr('A valid email is required.');

    try {
      const result = db.transaction(() => {
        const client = findOrCreateClient(db, name, email);
        if (!client.waiver_signed_at) {
          if (!waiver_agree) {
            const e = new BookingError('waiver_required', 'Please read and accept the waiver to book.');
            throw e;
          }
          db.prepare('UPDATE clients SET waiver_signed_at = ? WHERE id = ?')
            .run(new Date().toISOString(), client.id);
        }
        const booked = book(db, client.id, inst.id);
        // Drop-in without membership/pack: record the pending manual payment.
        let payment = null;
        if (booked.booking.paid_with === 'drop_in_manual' && inst.drop_in_price_cents > 0) {
          const info = db.prepare(
            `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status)
             VALUES (?, ?, ?, 'other', ?, 'drop_in', 'pending')`
          ).run(client.id, inst.drop_in_price_cents, getSetting(db, 'currency', 'HKD'),
            `Drop-in: ${inst.class_name} ${inst.starts_at}`);
          payment = info.lastInsertRowid;
        }
        audit(db, client.email, booked.waitlisted ? 'waitlist_join' : 'booking_create',
          `instance:${inst.id} booking:${booked.booking.id}`);
        return { client, ...booked, paymentId: payment };
      })();

      const magicUrl = `${services.baseUrl(req)}/me?token=${makeMagicToken(db, result.client.id)}`;
      const when = res.locals.fmtDt(inst.starts_at);
      const studio = getSetting(db, 'studio_name', 'the studio');
      const tpl = result.waitlisted
        ? emails.waitlisted({ studio, clientName: result.client.name, className: inst.class_name, when, magicUrl })
        : emails.bookingConfirmation({
            studio, clientName: result.client.name, className: inst.class_name, when,
            paidWith: result.booking.paid_with.replace(/_/g, ' '), magicUrl,
          });
      mailer.send({ to: result.client.email, ...tpl });

      res.render('public/book_result', {
        title: result.waitlisted ? 'Waitlisted' : 'Booked',
        inst, result, magicUrl,
      });
    } catch (err) {
      if (err instanceof BookingError) {
        const messages = {
          waiver_required: 'Please read and accept the waiver to book.',
          already_booked: 'You already have a booking for this class. Check your email for your management link.',
          in_past: 'This class has already started.',
          class_cancelled: 'This class has been cancelled.',
          no_credits: 'Your pass no longer has enough credits.',
        };
        return renderErr(messages[err.code] || err.message, 409);
      }
      throw err;
    }
  });

  // Buy page — packs + memberships.
  r.get('/buy', (req, res) => {
    const packs = db.prepare('SELECT * FROM pack_products WHERE active = 1 ORDER BY price_cents').all();
    const plans = db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY price_cents').all();
    res.render('public/buy', { title: 'Passes & Memberships', packs, plans, error: null });
  });

  r.post('/buy/pack/:id', async (req, res, next) => {
    const product = db.prepare('SELECT * FROM pack_products WHERE id = ? AND active = 1').get(req.params.id);
    if (!product) return res.status(404).render('error', { title: 'Not found', message: 'Pack not found.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).render('public/buy_manual', { title: 'Buy', product, plan: null, email: null, error: 'A valid email is required.' });
    }
    if (services.stripe.configured) {
      try {
        const session = await services.stripe.createPackCheckout({
          product, clientEmail: email, baseUrl: services.baseUrl(req),
          currency: getSetting(db, 'currency', 'HKD'),
        });
        return res.redirect(303, session.url);
      } catch (err) {
        return next(err);
      }
    }
    res.render('public/buy_manual', { title: 'Almost there', product, plan: null, email, error: null });
  });

  r.post('/buy/membership/:id', async (req, res, next) => {
    const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND active = 1').get(req.params.id);
    if (!plan) return res.status(404).render('error', { title: 'Not found', message: 'Plan not found.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).render('public/buy_manual', { title: 'Buy', product: null, plan, email: null, error: 'A valid email is required.' });
    }
    if (services.stripe.configured && plan.stripe_price_id) {
      try {
        const session = await services.stripe.createMembershipCheckout({
          plan, clientEmail: email, baseUrl: services.baseUrl(req),
        });
        return res.redirect(303, session.url);
      } catch (err) {
        return next(err);
      }
    }
    res.render('public/buy_manual', { title: 'Almost there', product: null, plan, email, error: null });
  });

  r.get('/buy/thanks', (req, res) => {
    res.render('public/buy_thanks', { title: 'Thank you' });
  });

  // Request a magic link by email.
  r.get('/magic-link', (req, res) => {
    res.render('public/magic_request', { title: 'My bookings', sent: false, magicUrl: null, error: null });
  });

  r.post('/magic-link', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
    if (!client) {
      // Don't leak which emails exist; show the same confirmation.
      return res.render('public/magic_request', { title: 'My bookings', sent: true, magicUrl: null, error: null });
    }
    const magicUrl = `${services.baseUrl(req)}/me?token=${makeMagicToken(db, client.id)}`;
    const studio = getSetting(db, 'studio_name', 'the studio');
    if (mailer.smtpConfigured) {
      mailer.send({ to: email, ...emails.magicLink({ studio, clientName: client.name, magicUrl }) });
      return res.render('public/magic_request', { title: 'My bookings', sent: true, magicUrl: null, error: null });
    }
    // SMTP off: surface the link on screen (spec: testable without SMTP).
    mailer.send({ to: email, ...emails.magicLink({ studio, clientName: client.name, magicUrl }) });
    res.render('public/magic_request', { title: 'My bookings', sent: true, magicUrl, error: null });
  });

  return r;
}
