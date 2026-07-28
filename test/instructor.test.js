// Instructor role (v0.2.0): migration, admin account management + class
// assignment, portal route guards, roster scoping, check-in. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb, setSetting } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createMailer } from '../src/services/mailer.js';
import { createUser } from '../src/services/auth.js';
import { makeClassType, makeInstance, makeClient, csrfToken } from './helpers.js';

function makeApp() {
  const db = openDb(':memory:');
  setSetting(db, 'studio_name', 'Instructor Test Studio');
  setSetting(db, 'setup_complete', '1');
  createUser(db, { email: 'owner@test.test', password: 'password123', role: 'owner' });
  const app = createApp({ db, mailer: createMailer({ env: {} }), env: {} });
  return { db, app };
}

function makeInstructor(db, { email = 'teach@test.test', password = 'teachpass1', name = 'Kim Lee' } = {}) {
  return createUser(db, { email, password, name, role: 'instructor' });
}

function assign(db, instructorId, classId) {
  db.prepare('INSERT INTO instructor_class_assignments (instructor_id, class_id) VALUES (?, ?)')
    .run(instructorId, classId);
}

async function login(agent, email, password) {
  const _csrf = await csrfToken(agent, '/admin/login');
  const res = await agent.post('/admin/login').type('form').send({ email, password, _csrf });
  return { res, _csrf };
}

test('migration v2: instructor role accepted, assignments table exists, owner intact', () => {
  const { db } = makeApp();
  const id = makeInstructor(db);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(id).role, 'instructor');
  assert.equal(db.prepare("SELECT role FROM users WHERE email = 'owner@test.test'").get().role, 'owner');
  assert.throws(() => db.prepare("UPDATE users SET role = 'bogus' WHERE id = ?").run(id), /CHECK/);
  const type = makeClassType(db);
  const inst = makeInstance(db, type);
  assign(db, id, inst);
  assert.ok(db.prepare('SELECT 1 FROM instructor_class_assignments WHERE instructor_id = ? AND class_id = ?').get(id, inst));
});

test('instructor login redirects to /instructor/schedule; /login aliases the form', async () => {
  const { db, app } = makeApp();
  makeInstructor(db);
  const alias = await request(app).get('/login');
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.location, '/admin/login');

  const agent = request.agent(app);
  const { res } = await login(agent, 'teach@test.test', 'teachpass1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/instructor/schedule');

  // owner still lands on /admin
  const admin = request.agent(app);
  const { res: res2 } = await login(admin, 'owner@test.test', 'password123');
  assert.equal(res2.headers.location, '/admin');
});

test('instructor cannot access /admin/* (403); anonymous still 302 to login', async () => {
  const { db, app } = makeApp();
  makeInstructor(db);
  const agent = request.agent(app);
  const { _csrf } = await login(agent, 'teach@test.test', 'teachpass1');

  for (const path of ['/admin', '/admin/clients', '/admin/schedule', '/admin/settings', '/admin/reports']) {
    const res = await agent.get(path);
    assert.equal(res.status, 403, `${path} should 403 for instructor`);
  }
  const post = await agent.post('/admin/settings').type('form').send({ studio_name: 'Hacked', _csrf });
  assert.equal(post.status, 403);

  const anon = await request(app).get('/admin');
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.location, '/admin/login');
});

test('portal guards: anonymous → login; admin → back to /admin', async () => {
  const { app } = makeApp();
  const anon = await request(app).get('/instructor/schedule');
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.location, '/admin/login');

  const admin = request.agent(app);
  await login(admin, 'owner@test.test', 'password123');
  const res = await admin.get('/instructor/schedule');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin');
});

test('schedule shows only assigned upcoming classes', async () => {
  const { db, app } = makeApp();
  const me = makeInstructor(db);
  const mine = makeClassType(db, { name: 'Assigned Aerial' });
  const other = makeClassType(db, { name: 'Unassigned Boxing' });
  const myClass = makeInstance(db, mine, { hoursFromNow: 24 });
  makeInstance(db, other, { hoursFromNow: 24 });
  assign(db, me, myClass);

  const agent = request.agent(app);
  await login(agent, 'teach@test.test', 'teachpass1');
  const res = await agent.get('/instructor/schedule');
  assert.equal(res.status, 200);
  assert.match(res.text, /Assigned Aerial/);
  assert.doesNotMatch(res.text, /Unassigned Boxing/);
});

test('roster: 200 for assigned class, 403 for unassigned', async () => {
  const { db, app } = makeApp();
  const me = makeInstructor(db);
  const type = makeClassType(db, { name: 'Spin' });
  const myClass = makeInstance(db, type, { hoursFromNow: 24 });
  const otherClass = makeInstance(db, type, { hoursFromNow: 48 });
  assign(db, me, myClass);
  const clientId = makeClient(db, { name: 'Rider One', email: 'rider@test.hk' });
  const { book } = await import('../src/services/booking.js');
  book(db, clientId, myClass);

  const agent = request.agent(app);
  await login(agent, 'teach@test.test', 'teachpass1');

  const ok = await agent.get(`/instructor/classes/${myClass}/roster`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Rider One/);
  assert.match(ok.text, /booked/);
  assert.doesNotMatch(ok.text, /rider@test.hk/, 'client emails are not exposed to instructors');

  const forbidden = await agent.get(`/instructor/classes/${otherClass}/roster`);
  assert.equal(forbidden.status, 403);
});

test('check-in: works for assigned class, 403 unassigned, 404 booking from another class', async () => {
  const { db, app } = makeApp();
  const me = makeInstructor(db);
  const type = makeClassType(db, { name: 'HIIT' });
  const myClass = makeInstance(db, type, { hoursFromNow: 24 });
  const otherClass = makeInstance(db, type, { hoursFromNow: 48 });
  assign(db, me, myClass);
  const c1 = makeClient(db, { email: 'a@test.hk' });
  const c2 = makeClient(db, { email: 'b@test.hk' });
  const { book } = await import('../src/services/booking.js');
  const { booking: myBooking } = book(db, c1, myClass);
  const { booking: otherBooking } = book(db, c2, otherClass);

  const agent = request.agent(app);
  const { _csrf } = await login(agent, 'teach@test.test', 'teachpass1');

  const ok = await agent.post(`/instructor/classes/${myClass}/checkin/${myBooking.id}`).type('form').send({ _csrf });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, `/instructor/classes/${myClass}/roster`);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(myBooking.id).status, 'attended');
  const roster = await agent.get(`/instructor/classes/${myClass}/roster`);
  assert.match(roster.text, /checked-in/);

  const forbidden = await agent.post(`/instructor/classes/${otherClass}/checkin/${otherBooking.id}`).type('form').send({ _csrf });
  assert.equal(forbidden.status, 403);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(otherBooking.id).status, 'booked');

  const wrongClass = await agent.post(`/instructor/classes/${myClass}/checkin/${otherBooking.id}`).type('form').send({ _csrf });
  assert.equal(wrongClass.status, 404);
});

test('admin UI: create instructor login, assign + unassign classes via checkboxes', async () => {
  const { db, app } = makeApp();
  const type = makeClassType(db, { name: 'Yin' });
  const ci1 = makeInstance(db, type, { hoursFromNow: 24 });
  const ci2 = makeInstance(db, type, { hoursFromNow: 48 });

  const agent = request.agent(app);
  const { _csrf } = await login(agent, 'owner@test.test', 'password123');

  // create: bad password rejected, good one lands on the assignment page
  const bad = await agent.post('/admin/instructors/new').type('form')
    .send({ name: 'New Teach', email: 'nt@test.test', password: 'short', _csrf });
  assert.equal(bad.status, 400);
  const good = await agent.post('/admin/instructors/new').type('form')
    .send({ name: 'New Teach', email: 'nt@test.test', password: 'longenough1', _csrf });
  assert.equal(good.status, 302);
  const user = db.prepare("SELECT * FROM users WHERE email = 'nt@test.test'").get();
  assert.equal(user.role, 'instructor');
  assert.equal(good.headers.location, `/admin/instructors/${user.id}/classes`);
  const dup = await agent.post('/admin/instructors/new').type('form')
    .send({ name: 'Dup', email: 'nt@test.test', password: 'longenough1', _csrf });
  assert.equal(dup.status, 400);
  assert.match(dup.text, /already has an account/);

  // listed on the instructors page
  const list = await agent.get('/admin/instructors');
  assert.match(list.text, /nt@test.test/);

  // assign both, then keep only one — unchecked box is removed
  const both = await agent.post(`/admin/instructors/${user.id}/classes`).type('form')
    .send({ class_ids: [String(ci1), String(ci2)], _csrf });
  assert.equal(both.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM instructor_class_assignments WHERE instructor_id = ?').get(user.id).c, 2);

  const one = await agent.post(`/admin/instructors/${user.id}/classes`).type('form')
    .send({ class_ids: String(ci1), _csrf });
  assert.equal(one.status, 302);
  const left = db.prepare('SELECT class_id FROM instructor_class_assignments WHERE instructor_id = ?').all(user.id);
  assert.deepEqual(left.map((r) => r.class_id), [ci1]);

  // form page renders with the surviving box checked
  const page = await agent.get(`/admin/instructors/${user.id}/classes`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`value="${ci1}" checked`));

  // unknown account id → 404
  const missing = await agent.get('/admin/instructors/9999/classes');
  assert.equal(missing.status, 404);
});
