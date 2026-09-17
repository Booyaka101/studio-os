// Deployment-shape regressions: the app behind a TLS-terminating reverse proxy
// (the layout README recommends), and the staff login as an email oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createStripeService } from '../src/services/stripe.js';
import { createUser, authenticate } from '../src/services/auth.js';
import { testDb, makeClient, csrfToken } from './helpers.js';
import { setSetting } from '../src/db/index.js';

/** The documented reverse-proxy deployment: TRUST_PROXY set, BASE_URL unset. */
function proxiedApp(db, extraEnv = {}) {
  return createApp({ db, env: { TRUST_PROXY: '1', ...extraEnv } });
}

const asHttps = (r) => r
  .set('X-Forwarded-Proto', 'https')
  .set('Host', 'booking.example.com');

test('magic links use https when the proxy terminated TLS', async () => {
  const db = testDb();
  makeClient(db, { email: 'rider@test.hk' });
  const agent = request.agent(proxiedApp(db));
  const token = await csrfToken(agent, '/magic-link');

  const res = await asHttps(agent.post('/magic-link'))
    .type('form').send({ _csrf: token, email: 'rider@test.hk' });

  const link = res.text.match(/https?:\/\/[^\s"<]+\/me\?token=[^\s"<&]+/);
  assert.ok(link, 'magic link should be shown on screen when SMTP is off');
  // The link carries a 7-day auth token. Emitting it as http:// puts that
  // token on the wire in plaintext.
  assert.match(link[0], /^https:\/\/booking\.example\.com\/me\?token=/);
});

test('the session cookie is marked Secure behind an https proxy, not on plain http', async () => {
  const db = testDb();
  const app = proxiedApp(db);
  const secureCookies = (r) => (r.headers['set-cookie'] || []).join(' ');

  const https = await asHttps(request(app).get('/magic-link'));
  assert.match(secureCookies(https), /secure/i);

  const http = await request(app).get('/magic-link').set('Host', 'booking.example.com');
  assert.doesNotMatch(secureCookies(http), /secure/i, 'local http dev must still work');
});

test('Stripe redirect URLs inherit the proxied scheme', async () => {
  const db = testDb();
  const created = [];
  const stripeService = createStripeService({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    client: {
      checkout: { sessions: { create: async (p) => { created.push(p); return { id: 'cs_1', url: 'https://checkout.test/s' }; } } },
    },
  });
  db.prepare(
    "INSERT INTO pack_products (name, credits, price_cents, active) VALUES ('10 Pack', 10, 150000, 1)"
  ).run();
  const productId = db.prepare('SELECT id FROM pack_products').get().id;

  const app = createApp({ db, stripeService, env: { TRUST_PROXY: '1' } });
  const agent = request.agent(app);
  const token = await csrfToken(agent, '/buy');
  await asHttps(agent.post(`/buy/pack/${productId}`))
    .type('form').send({ _csrf: token, email: 'rider@test.hk' });

  assert.equal(created.length, 1, 'checkout session should have been created');
  assert.match(created[0].success_url, /^https:\/\/booking\.example\.com\//);
  assert.match(created[0].cancel_url, /^https:\/\/booking\.example\.com\//);
});

test('app_secret is not reachable from templates', async () => {
  const db = testDb();
  setSetting(db, 'app_secret', 'SECRET-THAT-MUST-NOT-RENDER');
  const app = createApp({ db, env: {} });
  // Swap the view engine for one that dumps everything the template was given,
  // so this asserts on what a view can actually reach rather than on internals.
  app.engine('ejs', (file, options, cb) => cb(null, JSON.stringify(options)));

  const body = (await request(app).get('/no-such-page')).text;

  assert.doesNotMatch(body, /SECRET-THAT-MUST-NOT-RENDER/,
    'app_secret signs sessions and magic tokens — a view must not be able to render it');
  assert.match(body, /studio_name/, 'the rest of settings should still be there');
});

test('login takes the same work for a known and an unknown email', async () => {
  const db = testDb();
  createUser(db, { email: 'owner@studio.hk', password: 'correct horse battery', role: 'owner' });

  // Skipping bcrypt on a missing user answered ~3000x faster and made the
  // login form enumerate staff emails. Wall-clock is too flaky to assert on,
  // so assert the observable cause: a bcrypt comparison happens either way.
  const { default: bcrypt } = await import('bcryptjs');
  const realCompare = bcrypt.compareSync;
  let compares = 0;
  bcrypt.compareSync = (...args) => { compares += 1; return realCompare.apply(bcrypt, args); };
  try {
    compares = 0;
    assert.equal(authenticate(db, 'nosuchuser@studio.hk', 'guess'), null);
    assert.equal(compares, 1, 'an unknown email must still pay for a bcrypt comparison');

    compares = 0;
    assert.equal(authenticate(db, 'owner@studio.hk', 'guess'), null);
    assert.equal(compares, 1);
  } finally {
    bcrypt.compareSync = realCompare;
  }

  // and the happy path still works
  assert.ok(authenticate(db, 'owner@studio.hk', 'correct horse battery'));
});
