// All Stripe interaction lives here. The service is constructed with an
// injectable client so tests never touch the network. When env keys are absent
// the service reports unconfigured and every purchase flow falls back to manual.
import { audit } from '../db/index.js';
import { addDays, localDateStr } from '../lib/time.js';
import { getSetting } from '../db/index.js';

export function createStripeService({ env = process.env, client } = {}) {
  const secretKey = env.STRIPE_SECRET_KEY || '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || '';
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY || '';
  let stripe = client || null;

  async function getClient() {
    if (!secretKey) throw new Error('Stripe not configured');
    if (!stripe) {
      const Stripe = (await import('stripe')).default;
      stripe = new Stripe(secretKey);
    }
    return stripe;
  }

  return {
    configured: Boolean(secretKey),
    webhookConfigured: Boolean(webhookSecret),
    publishableKey,

    /** One-time Checkout for a class pack. Returns the session (url etc). */
    async createPackCheckout({ product, clientEmail, baseUrl, currency }) {
      const s = await getClient();
      return s.checkout.sessions.create({
        mode: 'payment',
        customer_email: clientEmail,
        line_items: product.stripe_price_id
          ? [{ price: product.stripe_price_id, quantity: 1 }]
          : [{
              price_data: {
                currency: currency.toLowerCase(),
                unit_amount: product.price_cents,
                product_data: { name: product.name },
              },
              quantity: 1,
            }],
        metadata: { kind: 'pack', pack_product_id: String(product.id), client_email: clientEmail },
        success_url: `${baseUrl}/buy/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/buy`,
      });
    },

    /** Subscription Checkout for a membership plan (needs stripe_price_id). */
    async createMembershipCheckout({ plan, clientEmail, baseUrl }) {
      const s = await getClient();
      if (!plan.stripe_price_id) throw new Error('Plan has no Stripe Price ID');
      return s.checkout.sessions.create({
        mode: 'subscription',
        customer_email: clientEmail,
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        metadata: { kind: 'membership', plan_id: String(plan.id), client_email: clientEmail },
        success_url: `${baseUrl}/buy/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/buy`,
      });
    },

    /** Verify webhook signature and return the event. Throws on bad signature. */
    async parseWebhook(rawBody, signature) {
      const s = await getClient();
      if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
      return s.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
  };
}

/**
 * Fulfill a completed Checkout session: create the pass or activate the
 * membership, and record the payment. Idempotent via payments.stripe_session_id
 * UNIQUE — a replayed webhook is a no-op. Pure DB logic (testable sans Stripe).
 */
export function fulfillCheckoutSession(db, session) {
  const meta = session.metadata || {};
  const email = (meta.client_email || session.customer_email
    || (session.customer_details && session.customer_details.email) || '').toLowerCase();
  if (!email) throw new Error('Checkout session has no client email');

  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM payments WHERE stripe_session_id = ?').get(session.id);
    if (existing) return { fulfilled: false, reason: 'already_processed' };

    let client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
    if (!client) {
      const info = db.prepare(
        "INSERT INTO clients (name, email, source) VALUES (?, ?, 'self')"
      ).run(email.split('@')[0], email);
      client = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
    }

    const currency = (session.currency || getSetting(db, 'currency', 'HKD')).toUpperCase();
    const amount = session.amount_total ?? 0;

    if (meta.kind === 'pack') {
      const product = db.prepare('SELECT * FROM pack_products WHERE id = ?').get(Number(meta.pack_product_id));
      if (!product) throw new Error(`Unknown pack product ${meta.pack_product_id}`);
      const tz = getSetting(db, 'timezone', 'Asia/Hong_Kong');
      const expiresOn = product.validity_days
        ? addDays(localDateStr(tz), product.validity_days) : null;
      db.prepare(
        `INSERT INTO passes (client_id, name, credits_total, credits_remaining, expires_on, price_paid_cents, source)
         VALUES (?, ?, ?, ?, ?, ?, 'purchase')`
      ).run(client.id, product.name, product.credits, product.credits, expiresOn, amount);
      db.prepare(
        `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status, stripe_session_id)
         VALUES (?, ?, ?, 'stripe', ?, 'pack', 'paid', ?)`
      ).run(client.id, amount, currency, product.name, session.id);
      audit(db, 'stripe-webhook', 'pack_fulfilled', `client:${client.id} product:${product.id}`);
      return { fulfilled: true, kind: 'pack', clientId: client.id };
    }

    if (meta.kind === 'membership') {
      const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(Number(meta.plan_id));
      if (!plan) throw new Error(`Unknown membership plan ${meta.plan_id}`);
      const tz = getSetting(db, 'timezone', 'Asia/Hong_Kong');
      const today = localDateStr(tz);
      db.prepare(
        `INSERT INTO memberships (client_id, plan_id, plan_name, status, started_on, renews_on,
                                  stripe_subscription_id, unlimited, credits_per_month, cycle_started_on)
         VALUES (?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?)`
      ).run(client.id, plan.id, plan.name, today, session.subscription || null,
        plan.unlimited, plan.credits_per_month, today);
      db.prepare(
        `INSERT INTO payments (client_id, amount_cents, currency, method, reference, what, status, stripe_session_id)
         VALUES (?, ?, ?, 'stripe', ?, 'membership', 'paid', ?)`
      ).run(client.id, amount, currency, plan.name, session.id);
      audit(db, 'stripe-webhook', 'membership_fulfilled', `client:${client.id} plan:${plan.id}`);
      return { fulfilled: true, kind: 'membership', clientId: client.id };
    }

    if (meta.kind === 'drop_in') {
      // Pay-online for a drop-in booking: mark the pending payment paid.
      const payment = db.prepare(
        "SELECT * FROM payments WHERE id = ? AND status = 'pending'"
      ).get(Number(meta.payment_id));
      if (payment) {
        db.prepare(
          "UPDATE payments SET status = 'paid', method = 'stripe', stripe_session_id = ? WHERE id = ?"
        ).run(session.id, payment.id);
        audit(db, 'stripe-webhook', 'drop_in_paid', `payment:${payment.id}`);
        return { fulfilled: true, kind: 'drop_in', clientId: payment.client_id };
      }
      return { fulfilled: false, reason: 'payment_not_found' };
    }

    return { fulfilled: false, reason: `unknown kind ${meta.kind}` };
  })();
}

/** Handle a parsed Stripe event. Returns a result object for logging. */
export function handleStripeEvent(db, event) {
  if (event.type === 'checkout.session.completed') {
    return fulfillCheckoutSession(db, event.data.object);
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const r = db.prepare(
      "UPDATE memberships SET status = 'cancelled' WHERE stripe_subscription_id = ?"
    ).run(sub.id);
    audit(db, 'stripe-webhook', 'subscription_cancelled', sub.id);
    return { fulfilled: r.changes > 0, kind: 'subscription_cancelled' };
  }
  return { fulfilled: false, reason: `ignored event ${event.type}` };
}
