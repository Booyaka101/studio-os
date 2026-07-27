// Rate limiter tests: fixed-window trigger + reset via an injected fake
// clock (no sleeping), and X-Forwarded-For handling with/without TRUST_PROXY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSetting } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createMailer } from '../src/services/mailer.js';
import { createUser } from '../src/services/auth.js';
import { csrfToken, makeClassType, makeInstance } from './helpers.js';

const OUTBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-rl-outbox-'));
const WINDOW = 15 * 60 * 1000;

function makeApp({ env = {}, now } = {}) {
  const db = openDb(':memory:');
  setSetting(db, 'studio_name', 'RL Studio');
  setSetting(db, 'setup_complete', '1');
  createUser(db, { email: 'owner@test.test', password: 'password123', role: 'owner' });
  const mailer = createMailer({ env: {}, outboxDir: OUTBOX });
  const app = createApp({ db, mailer, env, now });
  return { db, app };
}

test('/magic-link: 5 per 15 min, 6th → 429, next window resets', async () => {
  let t = 10 * WINDOW; // arbitrary fixed start
  const { app } = makeApp({ now: () => t });
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/magic-link');

  for (let i = 1; i <= 5; i++) {
    const res = await agent.post('/magic-link').type('form').send({ email: `x${i}@t.test`, _csrf });
    assert.equal(res.status, 200, `request ${i} allowed`);
  }
  const blocked = await agent.post('/magic-link').type('form').send({ email: 'x6@t.test', _csrf });
  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /Too many link requests/);
  assert.equal(blocked.headers['retry-after'], String(WINDOW / 1000));

  // advance the clock into the next window — allowed again
  t += WINDOW;
  const fresh = await agent.post('/magic-link').type('form').send({ email: 'x7@t.test', _csrf });
  assert.equal(fresh.status, 200);
});

test('/admin/login: 10 per 15 min, wrong passwords count, 11th → 429', async () => {
  let t = 10 * WINDOW;
  const { app } = makeApp({ now: () => t });
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/admin/login');

  for (let i = 1; i <= 10; i++) {
    const res = await agent.post('/admin/login').type('form')
      .send({ email: 'owner@test.test', password: 'wrong', _csrf });
    assert.equal(res.status, 401, `attempt ${i} rejected but not throttled`);
  }
  const blocked = await agent.post('/admin/login').type('form')
    .send({ email: 'owner@test.test', password: 'password123', _csrf });
  assert.equal(blocked.status, 429, 'even correct credentials are throttled');
  assert.match(blocked.text, /Too many login attempts/);
});

test('booking POSTs: 30 per 15 min shared across /class/:id/book', async () => {
  let t = 10 * WINDOW;
  const { db, app } = makeApp({ now: () => t });
  const type = makeClassType(db, { capacity: 100 });
  const instA = makeInstance(db, type, { hoursFromNow: 48 });
  const instB = makeInstance(db, type, { hoursFromNow: 72 });
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/class/${instA}`);

  // 30 posts (invalid email → 400, but each one counts) split across two
  // instances: the bucket is per route PATTERN, not per concrete URL.
  for (let i = 1; i <= 30; i++) {
    const inst = i % 2 ? instA : instB;
    const res = await agent.post(`/class/${inst}/book`).type('form').send({ email: 'nope', _csrf });
    assert.equal(res.status, 400, `request ${i} allowed through the limiter`);
  }
  const blocked = await agent.post(`/class/${instA}/book`).type('form')
    .send({ email: 'real@t.test', waiver_agree: '1', _csrf });
  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /Too many booking attempts/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM bookings').get().c, 0);

  t += WINDOW;
  const fresh = await agent.post(`/class/${instA}/book`).type('form')
    .send({ name: 'Real', email: 'real@t.test', waiver_agree: '1', _csrf });
  assert.equal(fresh.status, 200, 'window reset allows booking again');
});

test('X-Forwarded-For is ignored unless TRUST_PROXY is set', async () => {
  let t = 10 * WINDOW;
  // TRUST_PROXY unset: spoofed XFF headers cannot dodge the limit
  const { app } = makeApp({ now: () => t });
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/magic-link');
  for (let i = 1; i <= 5; i++) {
    await agent.post('/magic-link').type('form')
      .set('X-Forwarded-For', `1.2.3.${i}`).send({ email: 'a@t.test', _csrf });
  }
  const blocked = await agent.post('/magic-link').type('form')
    .set('X-Forwarded-For', '9.9.9.9').send({ email: 'a@t.test', _csrf });
  assert.equal(blocked.status, 429, 'spoofed XFF still shares the socket-IP bucket');

  // TRUST_PROXY=1: distinct forwarded IPs get distinct buckets
  const trusted = makeApp({ env: { TRUST_PROXY: '1' }, now: () => t });
  const agent2 = request.agent(trusted.app);
  const csrf2 = await csrfToken(agent2, '/magic-link');
  for (let i = 1; i <= 5; i++) {
    const res = await agent2.post('/magic-link').type('form')
      .set('X-Forwarded-For', '1.1.1.1').send({ email: 'a@t.test', _csrf: csrf2 });
    assert.equal(res.status, 200);
  }
  const sameIp = await agent2.post('/magic-link').type('form')
    .set('X-Forwarded-For', '1.1.1.1').send({ email: 'a@t.test', _csrf: csrf2 });
  assert.equal(sameIp.status, 429, 'same forwarded IP is limited');
  const otherIp = await agent2.post('/magic-link').type('form')
    .set('X-Forwarded-For', '2.2.2.2').send({ email: 'a@t.test', _csrf: csrf2 });
  assert.equal(otherIp.status, 200, 'different forwarded IP has its own bucket');
});
