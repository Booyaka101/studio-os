// Booking needs only an email, so the page it returns must not hand over the
// self-service link for whatever address was typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { testDb, makeClient, makeClassType, makeInstance, csrfToken } from './helpers.js';

function appWith(db, { smtp }) {
  const sent = [];
  const mailer = { smtpConfigured: smtp, async send(msg) { sent.push(msg); return true; } };
  return { app: createApp({ db, mailer, env: {} }), sent };
}

async function bookAs(app, instanceId, email) {
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, `/class/${instanceId}`);
  return agent.post(`/class/${instanceId}/book`).type('form').send({ _csrf, email, waiver_agree: '1' });
}

test('with SMTP on, booking in someone else\'s name does not reveal their link', async () => {
  const db = testDb();
  makeClient(db, { email: 'member@test.hk', name: 'Member' });
  const inst = makeInstance(db, makeClassType(db));
  const { app, sent } = appWith(db, { smtp: true });

  const res = await bookAs(app, inst, 'member@test.hk');

  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /\/me\?token=/);
  assert.match(res.text, /on its way/);
  // The owner of the address still gets their link, by email.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'member@test.hk');
  assert.match(sent[0].text, /\/me\?token=/);
});

test('with SMTP off, the link is still shown so the studio works offline', async () => {
  const db = testDb();
  const inst = makeInstance(db, makeClassType(db));
  const { app } = appWith(db, { smtp: false });

  const res = await bookAs(app, inst, 'walkin@test.hk');

  assert.equal(res.status, 200);
  assert.match(res.text, /\/me\?token=/);
});
