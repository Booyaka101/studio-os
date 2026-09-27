// Full-stack HTTP tests: setup wizard, auth, public booking round-trip with
// waiver, magic-link self-service, buy fallback, admin pages. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, setSetting, getSetting } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createMailer } from '../src/services/mailer.js';
import { makeMagicToken, verifyMagicToken, createUser } from '../src/services/auth.js';
import { makeClassType, makeInstance, makeClient, makePass, csrfToken } from './helpers.js';

const OUTBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-outbox-'));

function makeApp({ setup = true } = {}) {
  const db = openDb(':memory:');
  if (setup) {
    setSetting(db, 'studio_name', 'Web Test Studio');
    setSetting(db, 'setup_complete', '1');
    createUser(db, { email: 'owner@test.test', password: 'password123', role: 'owner' });
  }
  const mailer = createMailer({ env: {}, outboxDir: OUTBOX });
  const app = createApp({ db, mailer, env: {} });
  return { db, app };
}

/** Log the owner in on a cookie agent; returns the session's CSRF token for later POSTs. */
async function adminLogin(agent) {
  const _csrf = await csrfToken(agent, '/admin/login');
  const res = await agent.post('/admin/login').type('form')
    .send({ email: 'owner@test.test', password: 'password123', _csrf });
  assert.equal(res.status, 302);
  return _csrf;
}

test('first-run gate redirects everything to /setup', async () => {
  const { app } = makeApp({ setup: false });
  const res = await request(app).get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/setup');
  const wizard = await request(app).get('/setup');
  assert.equal(wizard.status, 200);
  assert.match(wizard.text, /Welcome to Studio OS/);
});

test('setup wizard creates owner + settings and logs in', async () => {
  const { db, app } = makeApp({ setup: false });
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/setup');
  const res = await agent.post('/setup').type('form').send({
    _csrf, studio_name: 'Harbour Yoga', timezone: 'Asia/Hong_Kong', currency: 'hkd',
    email: 'owner@harbour.hk', password: 'supersecret', password2: 'supersecret',
    seed_examples: '1',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin');
  assert.equal(getSetting(db, 'setup_complete'), '1');
  assert.equal(getSetting(db, 'studio_name'), 'Harbour Yoga');
  assert.equal(getSetting(db, 'currency'), 'HKD');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM class_types').get().c, 2, 'example types seeded');
  const admin = await agent.get('/admin');
  assert.equal(admin.status, 200, 'wizard session works');
  // completed setup no longer reachable
  const again = await request(app).get('/setup');
  assert.equal(again.status, 302);
});

test('setup validation rejects bad input', async () => {
  const { app } = makeApp({ setup: false });
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/setup');
  const res = await agent.post('/setup').type('form').send({
    _csrf, studio_name: 'X', timezone: 'Asia/Hong_Kong', currency: 'HKD',
    email: 'bad-email', password: 'supersecret', password2: 'supersecret',
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /valid owner email/);
});

test('staff login/logout; admin requires auth', async () => {
  const { app } = makeApp();
  const anon = await request(app).get('/admin');
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.location, '/admin/login');

  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/admin/login');
  const bad = await agent.post('/admin/login').type('form').send({ email: 'owner@test.test', password: 'wrong', _csrf });
  assert.equal(bad.status, 401);
  const good = await agent.post('/admin/login').type('form').send({ email: 'owner@test.test', password: 'password123', _csrf });
  assert.equal(good.status, 302);
  const dash = await agent.get('/admin');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Today's classes/);
  await agent.post('/admin/logout').type('form').send({ _csrf });
  const after = await agent.get('/admin');
  assert.equal(after.status, 302);
});

test('public schedule renders instances', async () => {
  const { db, app } = makeApp();
  const type = makeClassType(db, { name: 'Aerial Yoga' });
  makeInstance(db, type, { hoursFromNow: 24 });
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Aerial Yoga/);
  assert.match(res.text, /spots? left/);
});

test('guest booking round-trip: waiver required, then booked; client + waiver stored', async () => {
  const { db, app } = makeApp();
  const type = makeClassType(db, { name: 'Boxing', capacity: 5 });
  const inst = makeInstance(db, type, { hoursFromNow: 48 });

  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/class/${inst}`);

  // missing waiver → 409 with message
  const noWaiver = await agent.post(`/class/${inst}/book`).type('form')
    .send({ name: 'Jane Chan', email: 'jane@test.hk', _csrf });
  assert.equal(noWaiver.status, 409);
  assert.match(noWaiver.text, /accept the waiver/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM bookings').get().c, 0);

  // with waiver → booked
  const ok = await agent.post(`/class/${inst}/book`).type('form')
    .send({ name: 'Jane Chan', email: 'jane@test.hk', waiver_agree: '1', _csrf });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /You're booked/);
  const client = db.prepare('SELECT * FROM clients WHERE email = ?').get('jane@test.hk');
  assert.ok(client, 'client created');
  assert.equal(client.source, 'self');
  assert.ok(client.waiver_signed_at, 'waiver recorded');
  const booking = db.prepare('SELECT * FROM bookings WHERE client_id = ?').get(client.id);
  assert.equal(booking.status, 'booked');
  assert.equal(booking.paid_with, 'drop_in_manual');
  // pending drop-in payment recorded
  const payment = db.prepare('SELECT * FROM payments WHERE client_id = ?').get(client.id);
  assert.equal(payment.status, 'pending');

  // duplicate booking → friendly conflict
  const dup = await agent.post(`/class/${inst}/book`).type('form')
    .send({ name: 'Jane Chan', email: 'jane@test.hk', waiver_agree: '1', _csrf });
  assert.equal(dup.status, 409);
  assert.match(dup.text, /already have a booking/);
});

test('returning client with signed waiver books without checkbox, uses pack credit', async () => {
  const { db, app } = makeApp();
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  const clientId = makeClient(db, { email: 'returning@test.hk', waiver: true });
  makePass(db, clientId);

  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/class/${inst}`);
  const res = await agent.post(`/class/${inst}/book`).type('form')
    .send({ email: 'returning@test.hk', _csrf });
  assert.equal(res.status, 200);
  assert.match(res.text, /1 credit deducted from your class pack/);
});

test('a two-credit class says two credits came off the pack', async () => {
  const { db, app } = makeApp();
  const inst = makeInstance(db, makeClassType(db, { credits: 2 }), { hoursFromNow: 48 });
  makePass(db, makeClient(db, { email: 'double@test.hk', waiver: true }));
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/class/${inst}`);
  const res = await agent.post(`/class/${inst}/book`).type('form').send({ email: 'double@test.hk', _csrf });
  assert.match(res.text, /2 credits deducted from your class pack/);
});

test("booking with an existing client's email does not rename them", async () => {
  const { db, app } = makeApp();
  const inst = makeInstance(db, makeClassType(db), { hoursFromNow: 48 });
  const clientId = makeClient(db, { name: 'Mei Chan', email: 'mei@test.hk', waiver: true });

  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/class/${inst}`);
  const res = await agent.post(`/class/${inst}/book`).type('form')
    .send({ name: 'Someone Else', email: 'mei@test.hk', _csrf });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT name FROM clients WHERE id = ?').get(clientId).name, 'Mei Chan');
});

test('full class books to waitlist via HTTP', async () => {
  const { db, app } = makeApp();
  const type = makeClassType(db, { capacity: 1 });
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  makeClient(db, { email: 'a@t.hk' });
  const c = db.prepare('SELECT id FROM clients WHERE email=?').get('a@t.hk').id;
  const { book } = await import('../src/services/booking.js');
  book(db, c, inst);

  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/class/${inst}`);
  const res = await agent.post(`/class/${inst}/book`).type('form')
    .send({ email: 'b@t.hk', waiver_agree: '1', name: 'B', _csrf });
  assert.equal(res.status, 200);
  assert.match(res.text, /waitlist/i);
  assert.match(res.text, /You're #1 in line/);

  const second = await agent.post(`/class/${inst}/book`).type('form')
    .send({ email: 'c@t.hk', waiver_agree: '1', name: 'C', _csrf });
  assert.match(second.text, /You're #2 in line/);
});

test('drop-in dues: nothing owed on the waitlist, and a cancelled booking owes nothing', async () => {
  const { db, app } = makeApp();
  const inst = makeInstance(db, makeClassType(db, { capacity: 1, price: 15000 }), { hoursFromNow: 48 });
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/class/${inst}`);
  for (const email of ['first@t.hk', 'second@t.hk']) {
    await agent.post(`/class/${inst}/book`).type('form').send({ email, waiver_agree: '1', _csrf });
  }
  const owing = () => db.prepare(
    `SELECT c.email FROM payments p JOIN clients c ON c.id = p.client_id
     WHERE p.status = 'pending' ORDER BY p.id`
  ).all().map((r) => r.email);
  assert.deepEqual(owing(), ['first@t.hk']);

  const { cancelBooking } = await import('../src/services/booking.js');
  const first = db.prepare("SELECT id FROM bookings WHERE status = 'booked'").get();
  cancelBooking(db, first.id);
  assert.deepEqual(owing(), ['second@t.hk']);
});

test('admin: editing a class from the roster moves the waitlist up and emails them', async () => {
  const { db, app } = makeApp();
  const agent = request.agent(app);
  const _csrf = await adminLogin(agent);
  const inst = makeInstance(db, makeClassType(db, { capacity: 1 }), { hoursFromNow: 48 });
  const kim = db.prepare("INSERT INTO instructors (name) VALUES ('Kim')").run().lastInsertRowid;
  const { book } = await import('../src/services/booking.js');
  book(db, makeClient(db, { email: 'first@edit.hk' }), inst);
  const { booking: wl } = book(db, makeClient(db, { email: 'waiting@edit.hk' }), inst);

  const roster = await agent.get(`/admin/instances/${inst}`);
  assert.match(roster.text, /Edit class/);
  const res = await agent.post(`/admin/instances/${inst}/edit`).type('form')
    .send({ capacity: '2', instructor_id: String(kim), notes: 'Room B', _csrf });
  assert.equal(res.status, 302);
  const row = db.prepare('SELECT capacity, instructor_id, notes FROM class_instances WHERE id = ?').get(inst);
  assert.deepEqual({ ...row }, { capacity: 2, instructor_id: kim, notes: 'Room B' });
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(wl.id).status, 'booked');
  await new Promise((r) => setTimeout(r, 100));
  const mails = fs.readdirSync(OUTBOX).map((f) => fs.readFileSync(path.join(OUTBOX, f), 'utf8'));
  assert.ok(mails.some((m) => m.includes('To: waiting@edit.hk') && m.includes('/me?token=')));

  const bad = await agent.post(`/admin/instances/${inst}/edit`).type('form')
    .send({ capacity: '2', instructor_id: '999', _csrf });
  assert.equal(bad.status, 302, 'an unknown instructor is a flash, not a 500');
  assert.equal(db.prepare('SELECT instructor_id FROM class_instances WHERE id = ?').get(inst).instructor_id, kim);
});

test('magic link: verify round-trip, view bookings, cancel within policy', async () => {
  const { db, app } = makeApp();
  const type = makeClassType(db, { name: 'Spin' });
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  const clientId = makeClient(db, { email: 'magic@test.hk' });
  const passId = makePass(db, clientId);
  const { book } = await import('../src/services/booking.js');
  const { booking } = book(db, clientId, inst);

  const token = makeMagicToken(db, clientId);
  assert.equal(verifyMagicToken(db, token), clientId);
  assert.equal(verifyMagicToken(db, token + 'x'), null, 'tampered token rejected');
  assert.equal(verifyMagicToken(db, makeMagicToken(db, clientId, { now: Date.now() - 8 * 86400000 })), null, 'expired token rejected');

  const me = await request(app).get(`/me?token=${encodeURIComponent(token)}`);
  assert.equal(me.status, 200);
  assert.match(me.text, /Spin/);

  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/me?token=${encodeURIComponent(token)}`);
  const cancel = await agent.post(`/me/cancel/${booking.id}`).type('form').send({ token, _csrf });
  assert.equal(cancel.status, 302);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(booking.id).status, 'cancelled');
  assert.equal(db.prepare('SELECT credits_remaining FROM passes WHERE id=?').get(passId).credits_remaining, 10, 'credit refunded');

  const bad = await request(app).get('/me?token=garbage');
  assert.equal(bad.status, 401);
});

test('magic link cannot cancel another client\'s booking', async () => {
  const { db, app } = makeApp();
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  const victim = makeClient(db, { email: 'victim@test.hk' });
  const attacker = makeClient(db, { email: 'attacker@test.hk' });
  const { book } = await import('../src/services/booking.js');
  const { booking } = book(db, victim, inst);

  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/magic-link');
  const res = await agent.post(`/me/cancel/${booking.id}`).type('form')
    .send({ token: makeMagicToken(db, attacker), _csrf });
  assert.equal(res.status, 404);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(booking.id).status, 'booked');
});

test('buy page renders and manual fallback works without Stripe', async () => {
  const { db, app } = makeApp();
  db.prepare("INSERT INTO pack_products (name, credits, price_cents) VALUES ('10 Pack', 10, 150000)").run();
  const agent = request.agent(app);
  const buy = await agent.get('/buy');
  assert.equal(buy.status, 200);
  assert.match(buy.text, /10 Pack/);
  assert.match(buy.text, /pay at studio/i);
  const _csrf = buy.text.match(/name="_csrf" value="([^"]+)"/)[1];

  const packId = db.prepare('SELECT id FROM pack_products').get().id;
  const res = await agent.post(`/buy/pack/${packId}`).type('form').send({ email: 'buyer@test.hk', _csrf });
  assert.equal(res.status, 200);
  assert.match(res.text, /Pay at the studio/i);
});

test('admin: rules CRUD generates instances; roster check-in works over HTTP', async () => {
  const { db, app } = makeApp();
  const agent = request.agent(app);
  const _csrf = await adminLogin(agent);

  const type = makeClassType(db, { name: 'HIIT' });
  const rule = await agent.post('/admin/rules').type('form').send({
    class_type_id: String(type), weekday: '2', start_time: '18:30', _csrf,
  });
  assert.equal(rule.status, 302);
  const count = db.prepare('SELECT COUNT(*) c FROM class_instances').get().c;
  assert.equal(count, 8, 'rule creation materialized 8 weeks');

  // book someone in, then check them in via admin
  const clientId = makeClient(db, { email: 'roster@test.hk' });
  // the earliest instance of a Tuesday 18:30 rule is today's when the suite
  // runs on a Tuesday evening, and book() rejects a class that has started
  const instId = db.prepare(
    'SELECT id FROM class_instances WHERE starts_at > ? ORDER BY starts_at LIMIT 1'
  ).get(new Date().toISOString()).id;
  const { book } = await import('../src/services/booking.js');
  const { booking } = book(db, clientId, instId);

  const roster = await agent.get(`/admin/instances/${instId}`);
  assert.equal(roster.status, 200);
  assert.match(roster.text, /roster@test.hk/);

  const checkin = await agent.post(`/admin/bookings/${booking.id}/status`).type('form').send({ status: 'attended', _csrf });
  assert.equal(checkin.status, 302);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(booking.id).status, 'attended');
});

test('admin: editing a rule moves its empty classes instead of adding a second slot', async () => {
  const { db, app } = makeApp();
  const agent = request.agent(app);
  const _csrf = await adminLogin(agent);
  const { book } = await import('../src/services/booking.js');
  const { localTimeStr } = await import('../src/lib/time.js');

  const type = makeClassType(db, { name: 'Pilates' });
  await agent.post('/admin/rules').type('form').send({
    class_type_id: String(type), weekday: '4', start_time: '18:00', _csrf,
  });
  const ruleId = db.prepare('SELECT id FROM schedule_rules').get().id;
  const nowIso = new Date().toISOString();
  const future = () => db.prepare(
    'SELECT starts_at FROM class_instances WHERE rule_id = ? AND starts_at > ? ORDER BY starts_at'
  ).all(ruleId, nowIso).map((ci) => localTimeStr('Asia/Hong_Kong', ci.starts_at));
  const slots = future().length;
  const last = db.prepare('SELECT id FROM class_instances WHERE rule_id = ? ORDER BY starts_at DESC').get(ruleId).id;
  book(db, makeClient(db), last);

  const edit = await agent.post(`/admin/rules/${ruleId}`).type('form').send({
    class_type_id: String(type), weekday: '4', start_time: '19:00', _csrf,
  });
  assert.equal(edit.status, 302);
  const times = future();
  assert.equal(times.filter((t) => t === '18:00').length, 1, 'only the booked class stays at the old time');
  assert.equal(times.filter((t) => t === '19:00').length, slots);
  assert.match((await agent.get('/admin/rules')).text, /1 booked class\(es\) are still at the old time/);

  const bad = await agent.post(`/admin/rules/${ruleId}`).type('form').send({
    class_type_id: String(type), weekday: '4', start_time: 'seven', _csrf,
  });
  assert.equal(bad.status, 302);
  assert.equal(db.prepare('SELECT start_time FROM schedule_rules WHERE id = ?').get(ruleId).start_time, '19:00');
});

test('admin: manual pass sale + payment, revenue report and CSV export', async () => {
  const { db, app } = makeApp();
  const agent = request.agent(app);
  const _csrf = await adminLogin(agent);

  const clientId = makeClient(db, { email: 'payer@test.hk' });
  const sale = await agent.post(`/admin/clients/${clientId}/passes`).type('form').send({
    name: '10-class pack', credits: '10', price: '1500', method: 'cash', record_payment: '1', _csrf,
  });
  assert.equal(sale.status, 302);
  assert.equal(db.prepare('SELECT credits_remaining FROM passes WHERE client_id=?').get(clientId).credits_remaining, 10);
  const pay = db.prepare('SELECT * FROM payments WHERE client_id=?').get(clientId);
  assert.equal(pay.amount_cents, 150000);
  assert.equal(pay.status, 'paid');

  const reports = await agent.get('/admin/reports');
  assert.equal(reports.status, 200);
  assert.match(reports.text, /Revenue by month/);

  const csv = await agent.get('/admin/reports.csv?report=revenue');
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /month/);
});

test('admin: settings update + backup download', async () => {
  const { db, app } = makeApp();
  const agent = request.agent(app);
  const _csrf = await adminLogin(agent);

  const save = await agent.post('/admin/settings').type('form').send({
    studio_name: 'Renamed Studio', cancellation_window_hours: '24', late_cancel_policy: 'refund', _csrf,
  });
  assert.equal(save.status, 302);
  assert.equal(getSetting(db, 'studio_name'), 'Renamed Studio');
  assert.equal(getSetting(db, 'cancellation_window_hours'), '24');
  assert.equal(getSetting(db, 'late_cancel_policy'), 'refund');
});

test('admin: Mindbody import page dry-run previews, real run writes, re-run updates', async () => {
  const { db, app } = makeApp();
  const agent = request.agent(app);
  const _csrf = await adminLogin(agent);

  const csv = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mindbody-clients.csv'), 'utf8');
  const dry = await agent.post('/admin/import').type('form').send({ kind: 'clients', dry_run: '1', csv, _csrf });
  assert.equal(dry.status, 200);
  assert.match(dry.text, /dry run — nothing written/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 0);

  const real = await agent.post('/admin/import').type('form').send({ kind: 'clients', csv, _csrf });
  assert.equal(real.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 7);

  const again = await agent.post('/admin/import').type('form').send({ kind: 'clients', csv, _csrf });
  assert.equal(again.status, 200);
  assert.match(again.text, /<strong>0<\/strong> created/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 7, 'idempotent via the web UI too');
});

test('CSRF: state-changing POST without a token → 403, nothing written', async () => {
  const { db, app } = makeApp();
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 48 });

  // no session at all
  const bare = await request(app).post(`/class/${inst}/book`).type('form')
    .send({ name: 'Evil', email: 'evil@test.hk', waiver_agree: '1' });
  assert.equal(bare.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM bookings').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 0);

  // valid session, wrong token
  const agent = request.agent(app);
  await agent.get('/magic-link');
  const wrong = await agent.post('/magic-link').type('form')
    .send({ email: 'a@b.test', _csrf: 'not-the-real-token' });
  assert.equal(wrong.status, 403);

  // admin login is protected too — correct credentials without token still 403
  const login = await request(app).post('/admin/login').type('form')
    .send({ email: 'owner@test.test', password: 'password123' });
  assert.equal(login.status, 403);
});

test('CSRF: POST with a valid session token works; Stripe webhook stays exempt', async () => {
  const { app } = makeApp();
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/magic-link');
  const ok = await agent.post('/magic-link').type('form').send({ email: 'nobody@test.hk', _csrf });
  assert.equal(ok.status, 200);
  // exempt from CSRF (signature-verified raw body instead): 501 unconfigured, not 403
  const wh = await request(app).post('/webhooks/stripe').send({ some: 'payload' });
  assert.equal(wh.status, 501);
});

test('webhook endpoint returns 501 when Stripe is unconfigured', async () => {
  const { app } = makeApp();
  const res = await request(app).post('/webhooks/stripe').send({ some: 'payload' });
  assert.equal(res.status, 501);
});

test('emails are written to the outbox when SMTP is off', async () => {
  const { db, app } = makeApp();
  const type = makeClassType(db);
  const inst = makeInstance(db, type, { hoursFromNow: 48 });
  const before = fs.readdirSync(OUTBOX).length;
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/class/${inst}`);
  await agent.post(`/class/${inst}/book`).type('form')
    .send({ name: 'Mail Test', email: 'mail@test.hk', waiver_agree: '1', _csrf });
  // mailer.send is async fire-and-forget; give it a tick
  await new Promise((r) => setTimeout(r, 100));
  const after = fs.readdirSync(OUTBOX).length;
  assert.ok(after > before, 'an .eml file landed in the outbox');
  const latest = fs.readdirSync(OUTBOX).sort().pop();
  const content = fs.readFileSync(path.join(OUTBOX, latest), 'utf8');
  assert.match(content, /To: mail@test.hk/);
  assert.match(content, /\/me\?token=/);
});
