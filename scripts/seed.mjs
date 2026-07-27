#!/usr/bin/env node
// Seed a demo studio: settings + owner login, instructors, class types,
// weekly schedule rules (materialized), pack products, membership plans,
// a few clients with passes/memberships and two demo bookings.
//
// Usage: npm run seed            (refuses to touch a non-empty database)
//        npm run seed -- --force (seed anyway)
//        DB_PATH=... npm run seed
import process from 'node:process';
import { openDb, setSetting, getSetting } from '../src/db/index.js';
import { createUser } from '../src/services/auth.js';
import { generateInstances } from '../src/services/schedule.js';
import { book } from '../src/services/booking.js';

const force = process.argv.includes('--force');
const db = openDb(process.argv.includes('--db') ? process.argv[process.argv.indexOf('--db') + 1] : undefined);

const hasData = getSetting(db, 'setup_complete', '0') === '1'
  || db.prepare('SELECT COUNT(*) c FROM clients').get().c > 0;
if (hasData && !force) {
  console.error('Database already has data — refusing to seed. Re-run with --force to seed anyway.');
  process.exit(1);
}

const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = 'studio-demo';

db.transaction(() => {
  // --- settings + owner ------------------------------------------------
  setSetting(db, 'studio_name', 'Harbour Movement Studio');
  setSetting(db, 'timezone', 'Asia/Hong_Kong');
  setSetting(db, 'currency', 'HKD');
  setSetting(db, 'cancellation_window_hours', '12');
  setSetting(db, 'late_cancel_policy', 'forfeit');
  setSetting(db, 'waiver_markdown', [
    '## Liability waiver',
    '',
    'I understand that participation in classes at **Harbour Movement Studio** involves physical activity',
    'and carries a risk of injury. I confirm that I am physically fit to participate, and I agree to',
    'inform the instructor of any injuries or conditions before class.',
    '',
    'I release the studio and its instructors from liability for injuries sustained during normal',
    'class activity, except where caused by negligence.',
  ].join('\n'));
  if (!db.prepare('SELECT id FROM users WHERE email = ?').get(OWNER_EMAIL)) {
    createUser(db, { email: OWNER_EMAIL, password: OWNER_PASSWORD, name: 'Demo Owner', role: 'owner' });
  }
  setSetting(db, 'setup_complete', '1');

  // --- instructors ------------------------------------------------------
  const insInstructor = db.prepare('INSERT INTO instructors (name, bio) VALUES (?, ?)');
  const mei = insInstructor.run('Mei Ling', 'RYT-500 vinyasa and yin teacher, 8 years.').lastInsertRowid;
  const carlos = insInstructor.run('Carlos Reyes', 'Former gymnast; handstands and mobility.').lastInsertRowid;
  const priya = insInstructor.run('Priya Nair', 'Mat and reformer pilates, pre/post-natal certified.').lastInsertRowid;

  // --- class types ------------------------------------------------------
  const insType = db.prepare(
    'INSERT INTO class_types (name, description, duration_min, capacity, drop_in_price_cents, credits_required, color) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const vinyasa = insType.run('Vinyasa Flow', 'Breath-led flowing yoga, all levels.', 60, 14, 18000, 1, '#4f7cac').lastInsertRowid;
  const pilates = insType.run('Mat Pilates', 'Core-focused mat work.', 55, 10, 20000, 1, '#a06cd5').lastInsertRowid;
  const handstand = insType.run('Handstand Basics', 'Wall drills to freestanding holds.', 75, 8, 25000, 2, '#e07a5f').lastInsertRowid;
  const yin = insType.run('Yin & Restore', 'Slow deep stretch. Great for beginners.', 60, 16, 16000, 1, '#3d8168').lastInsertRowid;

  // --- weekly rules (studio-local times) --------------------------------
  const insRule = db.prepare(
    'INSERT INTO schedule_rules (class_type_id, instructor_id, weekday, start_time) VALUES (?, ?, ?, ?)'
  );
  insRule.run(vinyasa, mei, 1, '07:15');    // Mon
  insRule.run(vinyasa, mei, 3, '07:15');    // Wed
  insRule.run(vinyasa, mei, 6, '10:00');    // Sat
  insRule.run(pilates, priya, 2, '18:30');  // Tue
  insRule.run(pilates, priya, 4, '18:30');  // Thu
  insRule.run(handstand, carlos, 6, '14:00'); // Sat
  insRule.run(yin, mei, 0, '17:00');        // Sun
  insRule.run(yin, priya, 5, '19:30');      // Fri

  // --- products ---------------------------------------------------------
  const insPack = db.prepare('INSERT INTO pack_products (name, credits, price_cents, validity_days) VALUES (?, ?, ?, ?)');
  insPack.run('5 Class Pack', 5, 80000, 90);
  insPack.run('10 Class Pack', 10, 150000, 180);
  insPack.run('20 Class Pack', 20, 280000, 365);
  const insPlan = db.prepare('INSERT INTO membership_plans (name, price_cents, unlimited, credits_per_month) VALUES (?, ?, ?, ?)');
  insPlan.run('Unlimited Monthly', 128000, 1, null);
  insPlan.run('8 Classes / Month', 88000, 0, 8);

  // --- clients, passes, memberships ------------------------------------
  const insClient = db.prepare(
    "INSERT INTO clients (name, email, phone, waiver_signed_at, source) VALUES (?, ?, ?, ?, 'manual')"
  );
  const now = new Date().toISOString();
  const alice = insClient.run('Alice Chan', 'alice.chan@example.com', '+852 9123 0001', now).lastInsertRowid;
  const ben = insClient.run('Ben Kwok', 'ben.kwok@example.com', '+852 9123 0002', now).lastInsertRowid;
  const carmen = insClient.run('Carmen Ho', 'carmen.ho@example.com', '+852 9123 0003', now).lastInsertRowid;
  insClient.run('Dev Patel', 'dev.patel@example.com', '+852 9123 0004', null); // no waiver yet

  const in6months = new Date(Date.now() + 182 * 86400000).toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO passes (client_id, name, credits_total, credits_remaining, expires_on, price_paid_cents, source)
     VALUES (?, '10 Class Pack', 10, 7, ?, 150000, 'manual')`
  ).run(alice, in6months);
  db.prepare(
    `INSERT INTO passes (client_id, name, credits_total, credits_remaining, expires_on, price_paid_cents, source)
     VALUES (?, '5 Class Pack', 5, 5, ?, 80000, 'manual')`
  ).run(ben, in6months);
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO memberships (client_id, plan_name, status, started_on, unlimited, cycle_started_on)
     VALUES (?, 'Unlimited Monthly', 'active', ?, 1, ?)`
  ).run(carmen, today, today);
  db.prepare(
    `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status)
     VALUES (?, 150000, 'HKD', 'cash', '10 Class Pack', 'pack', 'paid')`
  ).run(alice);
  db.prepare(
    `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status)
     VALUES (?, 80000, 'HKD', 'fps', '5 Class Pack', 'pack', 'paid')`
  ).run(ben);
  db.prepare(
    `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status)
     VALUES (?, 128000, 'HKD', 'cash', 'Unlimited Monthly', 'membership', 'paid')`
  ).run(carmen);
})();

// Materialize the schedule, then drop two demo bookings on the nearest classes.
const created = generateInstances(db);
const upcoming = db.prepare(
  "SELECT id FROM class_instances WHERE status = 'scheduled' AND starts_at > ? ORDER BY starts_at LIMIT 2"
).all(new Date().toISOString());
const aliceId = db.prepare('SELECT id FROM clients WHERE email = ?').get('alice.chan@example.com').id;
const carmenId = db.prepare('SELECT id FROM clients WHERE email = ?').get('carmen.ho@example.com').id;
let bookings = 0;
for (const inst of upcoming) {
  try {
    book(db, aliceId, inst.id); bookings++;
    book(db, carmenId, inst.id); bookings++;
  } catch { /* capacity or duplicate — fine for a seed */ }
}

console.log(`Seeded demo studio "Harbour Movement Studio":
  3 instructors, 4 class types, 8 weekly rules → ${created} class instances
  3 pack products, 2 membership plans
  4 clients (2 passes, 1 unlimited membership), ${bookings} demo bookings

Admin login: ${OWNER_EMAIL} / ${OWNER_PASSWORD}
Start the app: npm start  →  http://localhost:3000`);
db.close();
