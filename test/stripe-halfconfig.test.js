// A Stripe secret key without STRIPE_WEBHOOK_SECRET used to send clients to
// Checkout anyway. They paid, /webhooks/stripe answered 501, and no pass and no
// payment row was ever created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createStripeService } from '../src/services/stripe.js';
import { createUser } from '../src/services/auth.js';
import { testDb, csrfToken } from './helpers.js';

/** A studio with one pack, one subscribable plan, and the given Stripe env. */
function studio(env) {
  const db = testDb();
  createUser(db, { email: 'owner@test.test', password: 'password123', role: 'owner' });
  db.prepare("INSERT INTO pack_products (name, credits, price_cents, active) VALUES ('10 Pack', 10, 150000, 1)").run();
  db.prepare("INSERT INTO membership_plans (name, price_cents, unlimited, active, stripe_price_id) VALUES ('Unlimited', 90000, 1, 1, 'price_x')").run();
  const created = [];
  const stripeService = createStripeService({
    env,
    client: {
      checkout: {
        sessions: {
          create: async (params) => {
            created.push(params);
            return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' };
          },
        },
      },
    },
  });
  return {
    db,
    created,
    packId: db.prepare('SELECT id FROM pack_products').get().id,
    planId: db.prepare('SELECT id FROM membership_plans').get().id,
    app: createApp({ db, stripeService, env: {} }),
  };
}

const HALF = { STRIPE_SECRET_KEY: 'sk_test_x' };
const FULL = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };

async function buy(app, path, form) {
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/buy');
  return agent.post(path).type('form').send({ _csrf, ...form });
}

test('a secret key without a webhook secret does not take money online', async () => {
  const { app, created, packId, planId } = studio(HALF);

  const pack = await buy(app, `/buy/pack/${packId}`, { email: 'rider@test.hk' });
  assert.equal(pack.status, 200, 'no redirect to Checkout');
  assert.match(pack.text, /pay/i);

  const plan = await buy(app, `/buy/membership/${planId}`, { email: 'rider@test.hk' });
  assert.equal(plan.status, 200);

  assert.deepEqual(created, [], 'no Checkout session should be created at all');
});

test('the buy page offers pay-at-studio when the webhook secret is missing', async () => {
  const half = await request(studio(HALF).app).get('/buy');
  assert.doesNotMatch(half.text, /Buy online|Subscribe online/);

  const full = await request(studio(FULL).app).get('/buy');
  assert.match(full.text, /Buy online/);
  assert.match(full.text, /Subscribe online/);
});

test('both keys present still redirects to Checkout', async () => {
  const { app, created, packId, planId } = studio(FULL);

  const pack = await buy(app, `/buy/pack/${packId}`, { email: 'rider@test.hk' });
  assert.equal(pack.status, 303);
  assert.equal(pack.headers.location, 'https://checkout.stripe.test/cs_1');

  const plan = await buy(app, `/buy/membership/${planId}`, { email: 'rider@test.hk' });
  assert.equal(plan.status, 303);

  assert.equal(created.length, 2);
});

test('admin pages report the missing webhook secret instead of "connected"', async () => {
  const { app } = studio(HALF);
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/admin/login');
  await agent.post('/admin/login').type('form').send({ email: 'owner@test.test', password: 'password123', _csrf });

  const dash = await agent.get('/admin');
  assert.doesNotMatch(dash.text, /Stripe: connected/);
  assert.match(dash.text, /webhook secret missing/i);

  const settings = await agent.get('/admin/settings');
  assert.match(settings.text, /Online payment is off/i);
  assert.doesNotMatch(settings.text, /see \.env/);
});
