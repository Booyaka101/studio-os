import { Router } from 'express';
import { setSetting, getSetting, audit } from '../db/index.js';
import { createUser } from '../services/auth.js';

const TIMEZONES = [
  'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Bangkok',
  'Australia/Sydney', 'Europe/London', 'Europe/Berlin', 'Europe/Paris',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC',
];

export default function setupRoutes({ db }) {
  const r = Router();

  r.get('/', (req, res) => {
    res.render('setup', { title: 'Setup', timezones: TIMEZONES, error: null, form: {} });
  });

  r.post('/', (req, res) => {
    const { studio_name, timezone, currency, email, password, password2, seed_examples } = req.body;
    const form = { studio_name, timezone, currency, email };
    const fail = (error) => res.status(400).render('setup', { title: 'Setup', timezones: TIMEZONES, error, form });

    if (!studio_name || !studio_name.trim()) return fail('Studio name is required.');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('A valid owner email is required.');
    if (!password || password.length < 8) return fail('Password must be at least 8 characters.');
    if (password !== password2) return fail('Passwords do not match.');
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      return fail('Invalid timezone.');
    }

    const userId = db.transaction(() => {
      setSetting(db, 'studio_name', studio_name.trim());
      setSetting(db, 'timezone', timezone || 'Asia/Hong_Kong');
      setSetting(db, 'currency', (currency || 'HKD').toUpperCase().slice(0, 3));
      const id = createUser(db, { email, password, name: 'Owner', role: 'owner' });
      if (seed_examples) {
        const ins = db.prepare(
          'INSERT INTO class_types (name, description, duration_min, capacity, drop_in_price_cents, credits_required, color) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        ins.run('Yoga Flow', 'All-levels vinyasa flow.', 60, 14, 18000, 1, '#4f7cac');
        ins.run('Mat Pilates', 'Core-focused mat work.', 55, 10, 20000, 1, '#a06cd5');
      }
      setSetting(db, 'setup_complete', '1');
      audit(db, email, 'setup_complete', 'studio');
      return id;
    })();

    req.session.userId = userId;
    res.redirect('/admin');
  });

  return r;
}
