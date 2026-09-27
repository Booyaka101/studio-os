// Requests that used to end in a 500, or in a crashed error page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/services/auth.js';
import { testDb, csrfToken } from './helpers.js';

function mindbodyClientsCsv(n) {
  const rows = ['First Name,Last Name,Email,Mobile Phone,Notes,Liability Waiver'];
  for (let i = 0; i < n; i++) {
    rows.push(`Client${i},Surname${i},client${i}@example.com,+852 5555 ${String(i).padStart(4, '0')},Prefers a mat by the window,Yes`);
  }
  return rows.join('\n');
}

test('Admin → Import takes a Mindbody export bigger than 100kb', async () => {
  const db = testDb();
  createUser(db, { email: 'owner@test.hk', password: 'password123', role: 'owner' });
  const agent = request.agent(createApp({ db, env: {} }));
  let _csrf = await csrfToken(agent, '/admin/login');
  await agent.post('/admin/login').type('form').send({ email: 'owner@test.hk', password: 'password123', _csrf });
  _csrf = await csrfToken(agent, '/admin/import');

  const csv = mindbodyClientsCsv(1500);
  assert.ok(csv.length > 100 * 1024);
  const res = await agent.post('/admin/import').type('form').send({ _csrf, kind: 'clients', csv });

  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 1500);
});

test('an oversized body elsewhere gets a 413 page, not a crashed error page', async () => {
  const db = testDb();
  const res = await request(createApp({ db, env: {} }))
    .post('/magic-link').type('form').send({ email: 'x'.repeat(200 * 1024) });

  assert.equal(res.status, 413);
  assert.match(res.text, /<main class="container">/);
  assert.doesNotMatch(res.text, /ReferenceError|at Layer/);
});

test('/me without a token asks for a new link instead of a 500', async () => {
  const db = testDb();
  const res = await request(createApp({ db, env: {} })).get('/me');

  assert.equal(res.status, 401);
  assert.match(res.text, /invalid or has expired/);
});
