import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireStaff, makeMagicToken, createUser } from '../services/auth.js';
import { getSetting, setSetting, audit } from '../db/index.js';
import { generateInstances, upcomingInstances } from '../services/schedule.js';
import {
  book, cancelBooking, cancelClass, markAttendance, BookingError,
} from '../services/booking.js';
import { importClients, importPasses } from '../services/importer.js';
import { emails } from '../services/mailer.js';
import { localDateStr, zonedToUtc, addDays } from '../lib/time.js';

export default function adminRoutes(services) {
  const { db, mailer } = services;
  const r = Router();
  r.use(requireStaff);

  const who = (req) => (req.session.userId
    ? (db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId) || {}).email || 'staff'
    : 'staff');

  // ---------------------------------------------------------------- dashboard
  r.get('/', (req, res) => {
    const tz = getSetting(db, 'timezone', 'Asia/Hong_Kong');
    const today = localDateStr(tz);
    const [y, m, d] = today.split('-').map(Number);
    const dayStart = zonedToUtc(tz, y, m, d, 0, 0).toISOString();
    const dayEnd = zonedToUtc(tz, y, m, d, 23, 59).toISOString();
    const todayClasses = db.prepare(
      `SELECT ci.*, ct.name AS class_name, ct.color, i.name AS instructor_name,
              (SELECT COUNT(*) FROM bookings b WHERE b.class_instance_id = ci.id
                 AND b.status IN ('booked','attended','no_show')) AS booked_count,
              (SELECT COUNT(*) FROM bookings b WHERE b.class_instance_id = ci.id
                 AND b.status = 'waitlist') AS waitlist_count
       FROM class_instances ci JOIN class_types ct ON ct.id = ci.class_type_id
       LEFT JOIN instructors i ON i.id = ci.instructor_id
       WHERE ci.starts_at BETWEEN ? AND ? ORDER BY ci.starts_at`
    ).all(dayStart, dayEnd);

    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const weekRevenue = db.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) total FROM payments WHERE status='paid' AND created_at >= ?"
    ).get(weekAgo).total;
    const pendingPayments = db.prepare(
      `SELECT p.*, c.name AS client_name FROM payments p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 20`
    ).all();
    const soon = addDays(today, 30);
    const expiringPasses = db.prepare(
      `SELECT p.*, c.name AS client_name FROM passes p JOIN clients c ON c.id = p.client_id
       WHERE p.credits_remaining > 0 AND p.expires_on IS NOT NULL AND p.expires_on BETWEEN ? AND ?
       ORDER BY p.expires_on LIMIT 20`
    ).all(today, soon);
    res.render('admin/dashboard', {
      title: 'Dashboard', todayClasses, weekRevenue, expiringPasses, pendingPayments,
    });
  });

  // ---------------------------------------------------------- class types CRUD
  r.get('/class-types', (req, res) => {
    const types = db.prepare('SELECT * FROM class_types ORDER BY active DESC, name').all();
    res.render('admin/class_types', { title: 'Class types', types });
  });

  r.post('/class-types', (req, res) => {
    const b = req.body;
    db.prepare(
      'INSERT INTO class_types (name, description, duration_min, capacity, drop_in_price_cents, credits_required, color) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(b.name, b.description || '', Number(b.duration_min) || 60, Number(b.capacity) || 10,
      Math.round(Number(b.drop_in_price || 0) * 100), Number(b.credits_required) || 1, b.color || '#4f7cac');
    audit(db, who(req), 'class_type_create', b.name);
    res.redirect('/admin/class-types');
  });

  r.post('/class-types/:id', (req, res) => {
    const b = req.body;
    if (b.action === 'toggle') {
      db.prepare('UPDATE class_types SET active = 1 - active WHERE id = ?').run(req.params.id);
    } else {
      db.prepare(
        'UPDATE class_types SET name=?, description=?, duration_min=?, capacity=?, drop_in_price_cents=?, credits_required=?, color=? WHERE id=?'
      ).run(b.name, b.description || '', Number(b.duration_min) || 60, Number(b.capacity) || 10,
        Math.round(Number(b.drop_in_price || 0) * 100), Number(b.credits_required) || 1,
        b.color || '#4f7cac', req.params.id);
    }
    audit(db, who(req), 'class_type_update', `class_type:${req.params.id}`);
    res.redirect('/admin/class-types');
  });

  // ---------------------------------------------------------- instructors CRUD
  r.get('/instructors', (req, res) => {
    const instructors = db.prepare('SELECT * FROM instructors ORDER BY active DESC, name').all();
    res.render('admin/instructors', { title: 'Instructors', instructors });
  });

  r.post('/instructors', (req, res) => {
    db.prepare('INSERT INTO instructors (name, bio) VALUES (?, ?)').run(req.body.name, req.body.bio || '');
    audit(db, who(req), 'instructor_create', req.body.name);
    res.redirect('/admin/instructors');
  });

  r.post('/instructors/:id', (req, res) => {
    if (req.body.action === 'toggle') {
      db.prepare('UPDATE instructors SET active = 1 - active WHERE id = ?').run(req.params.id);
    } else {
      db.prepare('UPDATE instructors SET name = ?, bio = ? WHERE id = ?')
        .run(req.body.name, req.body.bio || '', req.params.id);
    }
    audit(db, who(req), 'instructor_update', `instructor:${req.params.id}`);
    res.redirect('/admin/instructors');
  });

  // ---------------------------------------------------------- weekly rules CRUD
  r.get('/rules', (req, res) => {
    const rules = db.prepare(
      `SELECT sr.*, ct.name AS class_name, i.name AS instructor_name
       FROM schedule_rules sr JOIN class_types ct ON ct.id = sr.class_type_id
       LEFT JOIN instructors i ON i.id = sr.instructor_id
       ORDER BY sr.weekday, sr.start_time`
    ).all();
    const types = db.prepare('SELECT * FROM class_types WHERE active = 1 ORDER BY name').all();
    const instructors = db.prepare('SELECT * FROM instructors WHERE active = 1 ORDER BY name').all();
    res.render('admin/rules', { title: 'Weekly schedule rules', rules, types, instructors });
  });

  r.post('/rules', (req, res) => {
    const b = req.body;
    if (!/^\d{2}:\d{2}$/.test(b.start_time || '')) {
      req.session.flash = 'Start time must be HH:MM.';
      return res.redirect('/admin/rules');
    }
    db.prepare(
      'INSERT INTO schedule_rules (class_type_id, instructor_id, weekday, start_time, capacity_override, active_from, active_until) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(Number(b.class_type_id), Number(b.instructor_id) || null, Number(b.weekday),
      b.start_time, Number(b.capacity_override) || null, b.active_from || null, b.active_until || null);
    const created = generateInstances(db);
    audit(db, who(req), 'rule_create', `generated:${created}`);
    req.session.flash = `Rule created — ${created} class instances materialized.`;
    res.redirect('/admin/rules');
  });

  r.post('/rules/:id', (req, res) => {
    const b = req.body;
    if (b.action === 'delete') {
      // keep past instances; drop future not-yet-booked ones from this rule
      db.transaction(() => {
        db.prepare('UPDATE schedule_rules SET active = 0 WHERE id = ?').run(req.params.id);
        db.prepare(
          `DELETE FROM class_instances WHERE rule_id = ? AND starts_at > ? AND status = 'scheduled'
           AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.class_instance_id = class_instances.id AND b.status != 'cancelled')`
        ).run(req.params.id, new Date().toISOString());
      })();
      req.session.flash = 'Rule deactivated. Future empty instances removed; booked ones kept.';
    } else {
      db.prepare(
        'UPDATE schedule_rules SET class_type_id=?, instructor_id=?, weekday=?, start_time=?, capacity_override=?, active_from=?, active_until=? WHERE id=?'
      ).run(Number(b.class_type_id), Number(b.instructor_id) || null, Number(b.weekday),
        b.start_time, Number(b.capacity_override) || null, b.active_from || null,
        b.active_until || null, req.params.id);
      generateInstances(db);
      req.session.flash = 'Rule updated and schedule regenerated.';
    }
    audit(db, who(req), 'rule_update', `rule:${req.params.id}`);
    res.redirect('/admin/rules');
  });

  // ---------------------------------------------------------------- schedule
  r.get('/schedule', (req, res) => {
    const instances = upcomingInstances(db, { days: 14, includeCancelled: true });
    const types = db.prepare('SELECT * FROM class_types WHERE active = 1 ORDER BY name').all();
    const instructors = db.prepare('SELECT * FROM instructors WHERE active = 1 ORDER BY name').all();
    res.render('admin/schedule', { title: 'Schedule', instances, types, instructors });
  });

  // one-off class instance
  r.post('/schedule', (req, res) => {
    const b = req.body;
    const tz = getSetting(db, 'timezone', 'Asia/Hong_Kong');
    const type = db.prepare('SELECT * FROM class_types WHERE id = ?').get(Number(b.class_type_id));
    if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || !/^\d{2}:\d{2}$/.test(b.time || '')) {
      req.session.flash = 'Class type, date (YYYY-MM-DD) and time (HH:MM) are required.';
      return res.redirect('/admin/schedule');
    }
    const [y, m, d] = b.date.split('-').map(Number);
    const [hh, mm] = b.time.split(':').map(Number);
    const startsAt = zonedToUtc(tz, y, m, d, hh, mm).toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare(
      "INSERT INTO class_instances (class_type_id, instructor_id, starts_at, duration_min, capacity, status, notes) VALUES (?, ?, ?, ?, ?, 'scheduled', ?)"
    ).run(type.id, Number(b.instructor_id) || null, startsAt, type.duration_min,
      Number(b.capacity) || type.capacity, b.notes || '');
    audit(db, who(req), 'instance_create', startsAt);
    req.session.flash = 'One-off class created.';
    res.redirect('/admin/schedule');
  });

  r.post('/instances/:id/cancel', (req, res) => {
    try {
      const { instance, affected } = cancelClass(db, Number(req.params.id));
      audit(db, who(req), 'class_cancel', `instance:${instance.id} bookings:${affected.length}`);
      const studio = getSetting(db, 'studio_name', 'the studio');
      const when = res.locals.fmtDt(instance.starts_at);
      for (const bk of affected) {
        const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(bk.client_id);
        if (client) {
          mailer.send({
            to: client.email,
            ...emails.classCancelled({ studio, clientName: client.name, className: instance.class_name, when }),
          });
        }
      }
      req.session.flash = `Class cancelled. ${affected.length} booking(s) refunded and notified.`;
    } catch (err) {
      if (!(err instanceof BookingError)) throw err;
      req.session.flash = err.message;
    }
    res.redirect('/admin/schedule');
  });

  // ------------------------------------------------------------------ roster
  r.get('/instances/:id', (req, res) => {
    const inst = db.prepare(
      `SELECT ci.*, ct.name AS class_name, ct.credits_required, i.name AS instructor_name
       FROM class_instances ci JOIN class_types ct ON ct.id = ci.class_type_id
       LEFT JOIN instructors i ON i.id = ci.instructor_id WHERE ci.id = ?`
    ).get(req.params.id);
    if (!inst) return res.status(404).render('error', { title: 'Not found', message: 'Class not found.' });
    const roster = db.prepare(
      `SELECT b.*, c.name AS client_name, c.email FROM bookings b JOIN clients c ON c.id = b.client_id
       WHERE b.class_instance_id = ? AND b.status IN ('booked','attended','no_show')
       ORDER BY b.created_at`
    ).all(inst.id);
    const waitlist = db.prepare(
      `SELECT b.*, c.name AS client_name, c.email FROM bookings b JOIN clients c ON c.id = b.client_id
       WHERE b.class_instance_id = ? AND b.status = 'waitlist' ORDER BY b.created_at`
    ).all(inst.id);
    res.render('admin/roster', { title: `Roster — ${inst.class_name}`, inst, roster, waitlist });
  });

  r.post('/bookings/:id/status', (req, res) => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!booking) return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
    const status = req.body.status;
    try {
      if (status === 'cancelled') {
        const result = cancelBooking(db, booking.id, { forceRefund: req.body.refund === '1' });
        if (result.promoted) {
          const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.promoted.client_id);
          const inst = result.instance;
          const magicUrl = `${services.baseUrl(req)}/me?token=${makeMagicToken(db, c.id)}`;
          mailer.send({
            to: c.email,
            ...emails.waitlistPromotion({
              studio: getSetting(db, 'studio_name', ''), clientName: c.name,
              className: inst.class_name, when: res.locals.fmtDt(inst.starts_at), magicUrl,
            }),
          });
        }
      } else {
        markAttendance(db, booking.id, status);
      }
      audit(db, who(req), `booking_${status}`, `booking:${booking.id}`);
    } catch (err) {
      if (!(err instanceof BookingError)) throw err;
      req.session.flash = err.message;
    }
    res.redirect(`/admin/instances/${booking.class_instance_id}`);
  });

  r.post('/instances/:id/walkin', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      req.session.flash = 'A valid email is required for walk-ins.';
      return res.redirect(`/admin/instances/${req.params.id}`);
    }
    try {
      db.transaction(() => {
        let client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
        if (!client) {
          const info = db.prepare(
            "INSERT INTO clients (name, email, source) VALUES (?, ?, 'manual')"
          ).run(name || email.split('@')[0], email);
          client = { id: info.lastInsertRowid };
        }
        const paidWith = req.body.paid_with === 'comp' ? 'comp'
          : (req.body.paid_with === 'auto' ? 'auto' : 'drop_in_manual');
        book(db, client.id, Number(req.params.id), { paidWith, allowPast: true });
      })();
      req.session.flash = 'Walk-in added.';
      audit(db, who(req), 'walkin_add', `instance:${req.params.id} ${email}`);
    } catch (err) {
      if (!(err instanceof BookingError)) throw err;
      req.session.flash = err.message;
    }
    res.redirect(`/admin/instances/${req.params.id}`);
  });

  // ------------------------------------------------------------------ clients
  r.get('/clients', (req, res) => {
    const q = String(req.query.q || '').trim();
    const clients = q
      ? db.prepare(
          `SELECT * FROM clients WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY name LIMIT 200`
        ).all(`%${q}%`, `%${q}%`, `%${q}%`)
      : db.prepare('SELECT * FROM clients ORDER BY created_at DESC LIMIT 200').all();
    res.render('admin/clients', { title: 'Clients', clients, q });
  });

  r.post('/clients', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      req.session.flash = 'A valid email is required.';
      return res.redirect('/admin/clients');
    }
    try {
      const info = db.prepare(
        "INSERT INTO clients (name, email, phone, source) VALUES (?, ?, ?, 'manual')"
      ).run(req.body.name || email.split('@')[0], email, req.body.phone || '');
      audit(db, who(req), 'client_create', email);
      res.redirect(`/admin/clients/${info.lastInsertRowid}`);
    } catch (err) {
      req.session.flash = err.message.includes('UNIQUE') ? 'A client with that email already exists.' : err.message;
      res.redirect('/admin/clients');
    }
  });

  r.get('/clients/:id', (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return res.status(404).render('error', { title: 'Not found', message: 'Client not found.' });
    const bookings = db.prepare(
      `SELECT b.*, ci.starts_at, ct.name AS class_name FROM bookings b
       JOIN class_instances ci ON ci.id = b.class_instance_id
       JOIN class_types ct ON ct.id = ci.class_type_id
       WHERE b.client_id = ? ORDER BY ci.starts_at DESC LIMIT 100`
    ).all(client.id);
    const passes = db.prepare('SELECT * FROM passes WHERE client_id = ? ORDER BY created_at DESC').all(client.id);
    const memberships = db.prepare('SELECT * FROM memberships WHERE client_id = ? ORDER BY id DESC').all(client.id);
    const payments = db.prepare('SELECT * FROM payments WHERE client_id = ? ORDER BY created_at DESC LIMIT 100').all(client.id);
    const plans = db.prepare('SELECT * FROM membership_plans WHERE active = 1').all();
    const packProducts = db.prepare('SELECT * FROM pack_products WHERE active = 1').all();
    const magicUrl = `${services.baseUrl(req)}/me?token=${makeMagicToken(db, client.id)}`;
    res.render('admin/client', {
      title: client.name, client, bookings, passes, memberships, payments, plans, packProducts, magicUrl,
    });
  });

  r.post('/clients/:id', (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return res.status(404).render('error', { title: 'Not found', message: 'Client not found.' });
    if (req.body.action === 'waiver_toggle') {
      db.prepare('UPDATE clients SET waiver_signed_at = ? WHERE id = ?')
        .run(client.waiver_signed_at ? null : new Date().toISOString(), client.id);
    } else {
      db.prepare('UPDATE clients SET name = ?, phone = ?, notes = ? WHERE id = ?')
        .run(req.body.name || client.name, req.body.phone ?? client.phone, req.body.notes ?? client.notes, client.id);
    }
    audit(db, who(req), 'client_update', `client:${client.id}`);
    res.redirect(`/admin/clients/${client.id}`);
  });

  r.post('/clients/:id/passes', (req, res) => {
    const b = req.body;
    const credits = Number(b.credits) || 10;
    db.prepare(
      `INSERT INTO passes (client_id, name, credits_total, credits_remaining, expires_on, price_paid_cents, source)
       VALUES (?, ?, ?, ?, ?, ?, 'manual')`
    ).run(req.params.id, b.name || `${credits}-class pack`, credits, credits,
      b.expires_on || null, Math.round(Number(b.price || 0) * 100));
    if (b.record_payment === '1' && Number(b.price) > 0) {
      db.prepare(
        `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status)
         VALUES (?, ?, ?, ?, ?, 'pack', 'paid')`
      ).run(req.params.id, Math.round(Number(b.price) * 100), getSetting(db, 'currency', 'HKD'),
        b.method || 'cash', b.name || 'pack');
    }
    audit(db, who(req), 'pass_add', `client:${req.params.id}`);
    res.redirect(`/admin/clients/${req.params.id}`);
  });

  r.post('/clients/:id/memberships', (req, res) => {
    const b = req.body;
    if (b.action === 'status' && b.membership_id) {
      db.prepare('UPDATE memberships SET status = ? WHERE id = ? AND client_id = ?')
        .run(b.status, b.membership_id, req.params.id);
      audit(db, who(req), 'membership_status', `membership:${b.membership_id} → ${b.status}`);
      return res.redirect(`/admin/clients/${req.params.id}`);
    }
    const tz = getSetting(db, 'timezone', 'Asia/Hong_Kong');
    const today = localDateStr(tz);
    const plan = b.plan_id ? db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(b.plan_id) : null;
    db.prepare(
      `INSERT INTO memberships (client_id, plan_id, plan_name, status, started_on, unlimited, credits_per_month, cycle_started_on)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
    ).run(req.params.id, plan ? plan.id : null,
      plan ? plan.name : (b.plan_name || 'Membership'), today,
      plan ? plan.unlimited : (b.unlimited === '1' ? 1 : 0),
      plan ? plan.credits_per_month : (Number(b.credits_per_month) || null), today);
    if (plan && b.record_payment === '1') {
      db.prepare(
        `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status)
         VALUES (?, ?, ?, ?, ?, 'membership', 'paid')`
      ).run(req.params.id, plan.price_cents, getSetting(db, 'currency', 'HKD'), b.method || 'cash', plan.name);
    }
    audit(db, who(req), 'membership_add', `client:${req.params.id}`);
    res.redirect(`/admin/clients/${req.params.id}`);
  });

  r.post('/clients/:id/payments', (req, res) => {
    const b = req.body;
    db.prepare(
      `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status)
       VALUES (?, ?, ?, ?, ?, ?, 'paid')`
    ).run(req.params.id, Math.round(Number(b.amount || 0) * 100), getSetting(db, 'currency', 'HKD'),
      b.method || 'cash', b.reference || '', b.what || 'drop_in');
    audit(db, who(req), 'payment_record', `client:${req.params.id}`);
    res.redirect(`/admin/clients/${req.params.id}`);
  });

  r.post('/payments/:id/paid', (req, res) => {
    db.prepare("UPDATE payments SET status = 'paid', method = ? WHERE id = ? AND status = 'pending'")
      .run(req.body.method || 'cash', req.params.id);
    audit(db, who(req), 'payment_mark_paid', `payment:${req.params.id}`);
    res.redirect(req.get('referer') || '/admin');
  });

  // ---------------------------------------------------------------- products
  r.get('/products', (req, res) => {
    const packs = db.prepare('SELECT * FROM pack_products ORDER BY active DESC, price_cents').all();
    const plans = db.prepare('SELECT * FROM membership_plans ORDER BY active DESC, price_cents').all();
    res.render('admin/products', { title: 'Products', packs, plans });
  });

  r.post('/products/pack', (req, res) => {
    const b = req.body;
    db.prepare(
      'INSERT INTO pack_products (name, credits, price_cents, validity_days, stripe_price_id) VALUES (?, ?, ?, ?, ?)'
    ).run(b.name, Number(b.credits) || 10, Math.round(Number(b.price || 0) * 100),
      Number(b.validity_days) || null, b.stripe_price_id || null);
    audit(db, who(req), 'pack_product_create', b.name);
    res.redirect('/admin/products');
  });

  r.post('/products/pack/:id', (req, res) => {
    const b = req.body;
    if (b.action === 'toggle') {
      db.prepare('UPDATE pack_products SET active = 1 - active WHERE id = ?').run(req.params.id);
    } else {
      db.prepare(
        'UPDATE pack_products SET name=?, credits=?, price_cents=?, validity_days=?, stripe_price_id=? WHERE id=?'
      ).run(b.name, Number(b.credits) || 10, Math.round(Number(b.price || 0) * 100),
        Number(b.validity_days) || null, b.stripe_price_id || null, req.params.id);
    }
    res.redirect('/admin/products');
  });

  r.post('/products/plan', (req, res) => {
    const b = req.body;
    db.prepare(
      'INSERT INTO membership_plans (name, price_cents, unlimited, credits_per_month, stripe_price_id) VALUES (?, ?, ?, ?, ?)'
    ).run(b.name, Math.round(Number(b.price || 0) * 100), b.unlimited === '1' ? 1 : 0,
      b.unlimited === '1' ? null : Number(b.credits_per_month) || 8, b.stripe_price_id || null);
    audit(db, who(req), 'plan_create', b.name);
    res.redirect('/admin/products');
  });

  r.post('/products/plan/:id', (req, res) => {
    const b = req.body;
    if (b.action === 'toggle') {
      db.prepare('UPDATE membership_plans SET active = 1 - active WHERE id = ?').run(req.params.id);
    } else {
      db.prepare(
        'UPDATE membership_plans SET name=?, price_cents=?, unlimited=?, credits_per_month=?, stripe_price_id=? WHERE id=?'
      ).run(b.name, Math.round(Number(b.price || 0) * 100), b.unlimited === '1' ? 1 : 0,
        b.unlimited === '1' ? null : Number(b.credits_per_month) || 8, b.stripe_price_id || null, req.params.id);
    }
    res.redirect('/admin/products');
  });

  // ----------------------------------------------------------------- reports
  function revenueByMonth() {
    const tz = getSetting(db, 'timezone', 'Asia/Hong_Kong');
    const rows = db.prepare(
      "SELECT created_at, amount_cents, what FROM payments WHERE status = 'paid'"
    ).all();
    const byMonth = new Map();
    for (const p of rows) {
      const month = localDateStr(tz, p.created_at).slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, { month, total: 0, drop_in: 0, pack: 0, membership: 0, count: 0 });
      const m = byMonth.get(month);
      m.total += p.amount_cents;
      m[p.what] += p.amount_cents;
      m.count++;
    }
    return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
  }

  function attendanceByType() {
    return db.prepare(
      `SELECT ct.name AS class_type,
              SUM(CASE WHEN b.status = 'attended' THEN 1 ELSE 0 END) AS attended,
              SUM(CASE WHEN b.status = 'no_show' THEN 1 ELSE 0 END) AS no_shows,
              SUM(CASE WHEN b.status = 'booked' THEN 1 ELSE 0 END) AS booked,
              COUNT(*) AS total
       FROM bookings b
       JOIN class_instances ci ON ci.id = b.class_instance_id
       JOIN class_types ct ON ct.id = ci.class_type_id
       WHERE b.status IN ('attended','no_show','booked')
       GROUP BY ct.id ORDER BY total DESC`
    ).all();
  }

  r.get('/reports', (req, res) => {
    res.render('admin/reports', {
      title: 'Reports', revenue: revenueByMonth(), attendance: attendanceByType(),
    });
  });

  r.get('/reports.csv', (req, res) => {
    const report = req.query.report === 'attendance' ? 'attendance' : 'revenue';
    const rows = report === 'attendance' ? attendanceByType() : revenueByMonth();
    if (!rows.length) return res.type('text/csv').send('');
    const headers = Object.keys(rows[0]);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [headers.join(','), ...rows.map((r2) => headers.map((h) => esc(r2[h])).join(','))].join('\r\n');
    res.setHeader('Content-Disposition', `attachment; filename="${report}.csv"`);
    res.type('text/csv').send(csv);
  });

  // ---------------------------------------------------------------- settings
  r.get('/settings', (req, res) => {
    res.render('admin/settings', { title: 'Settings' });
  });

  r.post('/settings', (req, res) => {
    const b = req.body;
    if (b.studio_name) setSetting(db, 'studio_name', b.studio_name.trim());
    if (b.currency) setSetting(db, 'currency', b.currency.toUpperCase().slice(0, 3));
    if (b.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: b.timezone });
        setSetting(db, 'timezone', b.timezone);
      } catch { req.session.flash = 'Invalid timezone — not saved.'; }
    }
    if (b.cancellation_window_hours !== undefined) {
      setSetting(db, 'cancellation_window_hours', String(Math.max(0, Number(b.cancellation_window_hours) || 0)));
    }
    if (b.late_cancel_policy) {
      setSetting(db, 'late_cancel_policy', b.late_cancel_policy === 'refund' ? 'refund' : 'forfeit');
    }
    if (b.waiver_markdown !== undefined) setSetting(db, 'waiver_markdown', b.waiver_markdown);
    audit(db, who(req), 'settings_update', 'settings');
    if (!req.session.flash) req.session.flash = 'Settings saved.';
    res.redirect('/admin/settings');
  });

  r.get('/backup', (req, res, next) => {
    try {
      const tmp = path.join(os.tmpdir(), `studio-backup-${Date.now()}.db`);
      db.prepare('VACUUM INTO ?').run(tmp);
      audit(db, who(req), 'backup_download', 'studio.db');
      res.download(tmp, `studio-backup-${localDateStr(getSetting(db, 'timezone', 'UTC'))}.db`, (err) => {
        fs.unlink(tmp, () => {});
        if (err && !res.headersSent) next(err);
      });
    } catch (err) { next(err); }
  });

  // ------------------------------------------------------------------- staff
  r.post('/staff', (req, res) => {
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!me || me.role !== 'owner') {
      req.session.flash = 'Only the owner can add staff.';
      return res.redirect('/admin/settings');
    }
    try {
      createUser(db, {
        email: req.body.email, password: req.body.password,
        name: req.body.name || '', role: 'staff',
      });
      req.session.flash = 'Staff account created.';
      audit(db, who(req), 'staff_create', req.body.email);
    } catch (err) {
      req.session.flash = err.message.includes('UNIQUE') ? 'That email already has an account.' : err.message;
    }
    res.redirect('/admin/settings');
  });

  // ------------------------------------------------------------------ import
  r.get('/import', (req, res) => {
    res.render('admin/import', { title: 'Mindbody import', result: null, kind: null, dryRun: true });
  });

  r.post('/import', (req, res) => {
    const kind = req.body.kind === 'passes' ? 'passes' : 'clients';
    const dryRun = req.body.dry_run === '1';
    const csv = String(req.body.csv || '');
    if (!csv.trim()) {
      req.session.flash = 'Paste CSV content first.';
      return res.redirect('/admin/import');
    }
    const result = kind === 'passes'
      ? importPasses(db, csv, { dryRun })
      : importClients(db, csv, { dryRun });
    audit(db, who(req), `import_${kind}${dryRun ? '_dryrun' : ''}`,
      `created:${result.created} updated:${result.updated} skipped:${result.skipped}`);
    res.render('admin/import', { title: 'Mindbody import', result, kind, dryRun });
  });

  return r;
}
