// Stripe webhook fulfillment with the injectable mock client. No network:
// the mock implements exactly the surface src/services/stripe.js touches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createStripeService, fulfillCheckoutSession } from '../src/services/stripe.js';
import { createMailer } from '../src/services/mailer.js';
import { createUser } from '../src/services/auth.js';
import { openDb, setSetting } from '../src/db/index.js';

const VALID_SIG = 't=123,v1=goodsignature';

/** Mock of the stripe npm client: signature check + checkout session capture. */
function mockStripeClient() {
  const created = [];
  return {
    created,
    checkout: {
      sessions: {
        create: async (params) => {
          created.push(params);
          return { id: `cs_test_${created.length}`, url: 'https://checkout.stripe.test/session', ...params };
        },
      },
    },
    webhooks: {
      constructEvent(rawBody, signature, secret) {
        if (!secret) throw new Error('no webhook secret');
        if (signature !== VALID_SIG) throw new Error('No signatures found matching the expected signature for payload');
        return JSON.parse(rawBody.toString('utf8'));
      },
    },
  };
}

function makeApp() {
  const db = openDb(':memory:');
  setSetting(db, 'studio_name', 'Stripe Test Studio');
  setSetting(db, 'setup_complete', '1');
  createUser(db, { email: 'owner@test.test', password: 'password123', role: 'owner' });
  const client = mockStripeClient();
  const stripeService = createStripeService({
    env: { STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: 'whsec_mock', STRIPE_PUBLISHABLE_KEY: 'pk_test_mock' },
    client,
  });
  const mailer = createMailer({ env: {} });
  const app = createApp({ db, mailer, stripeService, env: {} });
  return { db, app, client };
}

function postEvent(app, event, sig = VALID_SIG) {
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', sig)
    .set('content-type', 'application/json')
    .send(JSON.stringify(event));
}

function checkoutCompleted(session) {
  return { type: 'checkout.session.completed', data: { object: session } };
}

test('webhook rejects a bad signature with 400', async () => {
  const { app } = makeApp();
  const res = await postEvent(app, checkoutCompleted({ id: 'cs_x' }), 'bogus');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Signature verification failed/);
});

test('pack checkout fulfillment: creates client, pass and paid payment row', async () => {
  const { db, app } = makeApp();
  const productId = db.prepare(
    "INSERT INTO pack_products (name, credits, price_cents, validity_days) VALUES ('10 Class Pack', 10, 150000, 180)"
  ).run().lastInsertRowid;

  const res = await postEvent(app, checkoutCompleted({
    id: 'cs_pack_1',
    amount_total: 150000,
    currency: 'hkd',
    metadata: { kind: 'pack', pack_product_id: String(productId), client_email: 'newbie@test.hk' },
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.fulfilled, true);
  assert.equal(res.body.kind, 'pack');

  const client = db.prepare('SELECT * FROM clients WHERE email = ?').get('newbie@test.hk');
  assert.ok(client, 'client auto-created from checkout email');
  const pass = db.prepare('SELECT * FROM passes WHERE client_id = ?').get(client.id);
  assert.equal(pass.credits_total, 10);
  assert.equal(pass.credits_remaining, 10);
  assert.equal(pass.source, 'purchase');
  assert.ok(pass.expires_on, 'validity_days produced an expiry date');
  const payment = db.prepare('SELECT * FROM payments WHERE stripe_session_id = ?').get('cs_pack_1');
  assert.equal(payment.amount_cents, 150000);
  assert.equal(payment.method, 'stripe');
  assert.equal(payment.status, 'paid');
  assert.equal(payment.what, 'pack');
});

test('replayed webhook is a no-op (idempotent by stripe_session_id)', async () => {
  const { db, app } = makeApp();
  const productId = db.prepare(
    "INSERT INTO pack_products (name, credits, price_cents) VALUES ('5 Pack', 5, 55000)"
  ).run().lastInsertRowid;
  const session = {
    id: 'cs_replay',
    amount_total: 55000,
    currency: 'hkd',
    metadata: { kind: 'pack', pack_product_id: String(productId), client_email: 'replay@test.hk' },
  };
  const first = await postEvent(app, checkoutCompleted(session));
  assert.equal(first.body.fulfilled, true);
  const second = await postEvent(app, checkoutCompleted(session));
  assert.equal(second.status, 200, 'replay is acknowledged so Stripe stops retrying');
  assert.equal(second.body.fulfilled, false);
  assert.equal(second.body.reason, 'already_processed');

  const client = db.prepare('SELECT * FROM clients WHERE email = ?').get('replay@test.hk');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM passes WHERE client_id = ?').get(client.id).c, 1, 'no duplicate pass');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payments').get().c, 1, 'no duplicate payment');
});

test('membership checkout fulfillment: activates membership with subscription id', async () => {
  const { db, app } = makeApp();
  const planId = db.prepare(
    "INSERT INTO membership_plans (name, price_cents, unlimited, stripe_price_id) VALUES ('Unlimited Monthly', 128000, 1, 'price_mock')"
  ).run().lastInsertRowid;

  const res = await postEvent(app, checkoutCompleted({
    id: 'cs_member_1',
    amount_total: 128000,
    currency: 'hkd',
    subscription: 'sub_mock_1',
    metadata: { kind: 'membership', plan_id: String(planId), client_email: 'member@test.hk' },
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.fulfilled, true);
  assert.equal(res.body.kind, 'membership');

  const client = db.prepare('SELECT * FROM clients WHERE email = ?').get('member@test.hk');
  const m = db.prepare('SELECT * FROM memberships WHERE client_id = ?').get(client.id);
  assert.equal(m.status, 'active');
  assert.equal(m.unlimited, 1);
  assert.equal(m.stripe_subscription_id, 'sub_mock_1');
  const payment = db.prepare('SELECT * FROM payments WHERE stripe_session_id = ?').get('cs_member_1');
  assert.equal(payment.what, 'membership');
  assert.equal(payment.status, 'paid');
});

test('customer.subscription.deleted cancels the matching membership', async () => {
  const { db, app } = makeApp();
  const clientId = db.prepare(
    "INSERT INTO clients (name, email, source) VALUES ('M', 'm@test.hk', 'self')"
  ).run().lastInsertRowid;
  db.prepare(
    `INSERT INTO memberships (client_id, plan_name, status, started_on, stripe_subscription_id, unlimited)
     VALUES (?, 'Unlimited', 'active', '2026-07-01', 'sub_gone', 1)`
  ).run(clientId);

  const res = await postEvent(app, { type: 'customer.subscription.deleted', data: { object: { id: 'sub_gone' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.fulfilled, true);
  assert.equal(db.prepare('SELECT status FROM memberships WHERE client_id = ?').get(clientId).status, 'cancelled');
});

test('drop-in checkout marks the pending payment paid', async () => {
  const { db, app } = makeApp();
  const clientId = db.prepare(
    "INSERT INTO clients (name, email, source) VALUES ('D', 'd@test.hk', 'self')"
  ).run().lastInsertRowid;
  const paymentId = db.prepare(
    `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status)
     VALUES (?, 18000, 'HKD', 'other', 'drop-in', 'drop_in', 'pending')`
  ).run(clientId).lastInsertRowid;

  const res = await postEvent(app, checkoutCompleted({
    id: 'cs_dropin_1',
    amount_total: 18000,
    currency: 'hkd',
    metadata: { kind: 'drop_in', payment_id: String(paymentId), client_email: 'd@test.hk' },
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.fulfilled, true);
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  assert.equal(p.status, 'paid');
  assert.equal(p.method, 'stripe');
  assert.equal(p.stripe_session_id, 'cs_dropin_1');
});

test('fulfillment failure returns 500 so Stripe retries', async () => {
  const { app } = makeApp();
  const res = await postEvent(app, checkoutCompleted({
    id: 'cs_broken',
    amount_total: 1000,
    currency: 'hkd',
    metadata: { kind: 'pack', pack_product_id: '9999', client_email: 'x@test.hk' },
  }));
  assert.equal(res.status, 500);
  assert.match(res.body.error, /Unknown pack product/);
});

test('unhandled event types are acknowledged and ignored', async () => {
  const { app } = makeApp();
  const res = await postEvent(app, { type: 'invoice.paid', data: { object: {} } });
  assert.equal(res.status, 200);
  assert.equal(res.body.fulfilled, false);
  assert.match(res.body.reason, /ignored event/);
});

test('createPackCheckout uses price_data fallback and pack metadata', async () => {
  const { client } = { client: mockStripeClient() };
  const svc = createStripeService({ env: { STRIPE_SECRET_KEY: 'sk_test_mock' }, client });
  const session = await svc.createPackCheckout({
    product: { id: 3, name: '10 Class Pack', price_cents: 150000, stripe_price_id: null },
    clientEmail: 'buyer@test.hk',
    baseUrl: 'http://studio.test',
    currency: 'HKD',
  });
  assert.ok(session.url);
  const params = client.created[0];
  assert.equal(params.mode, 'payment');
  assert.equal(params.line_items[0].price_data.unit_amount, 150000);
  assert.equal(params.line_items[0].price_data.currency, 'hkd');
  assert.equal(params.metadata.kind, 'pack');
  assert.equal(params.metadata.pack_product_id, '3');
  assert.match(params.success_url, /^http:\/\/studio\.test\/buy\/thanks/);
});

test('createMembershipCheckout requires a Stripe Price ID', async () => {
  const client = mockStripeClient();
  const svc = createStripeService({ env: { STRIPE_SECRET_KEY: 'sk_test_mock' }, client });
  await assert.rejects(
    () => svc.createMembershipCheckout({ plan: { id: 1, name: 'X', stripe_price_id: null }, clientEmail: 'a@b.c', baseUrl: 'http://x' }),
    /no Stripe Price ID/
  );
  const session = await svc.createMembershipCheckout({
    plan: { id: 1, name: 'Unlimited', stripe_price_id: 'price_123' },
    clientEmail: 'a@b.c', baseUrl: 'http://studio.test',
  });
  assert.ok(session.url);
  assert.equal(client.created[0].mode, 'subscription');
  assert.equal(client.created[0].line_items[0].price, 'price_123');
});

test('fulfillCheckoutSession throws when the session has no email', () => {
  const db = openDb(':memory:');
  assert.throws(() => fulfillCheckoutSession(db, { id: 'cs_no_email', metadata: {} }), /no client email/);
});
