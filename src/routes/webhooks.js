import { Router } from 'express';
import { handleStripeEvent } from '../services/stripe.js';

export default function webhookRoutes({ db, stripe }) {
  const r = Router();

  r.post('/', async (req, res) => {
    if (!stripe.configured || !stripe.webhookConfigured) {
      return res.status(501).json({ error: 'Stripe not configured' });
    }
    let event;
    try {
      event = await stripe.parseWebhook(req.body, req.headers['stripe-signature']);
    } catch (err) {
      return res.status(400).json({ error: `Signature verification failed: ${err.message}` });
    }
    try {
      const result = handleStripeEvent(db, event);
      return res.json({ received: true, ...result });
    } catch (err) {
      console.error('[webhook] fulfillment failed:', err.message);
      // 500 so Stripe retries
      return res.status(500).json({ error: err.message });
    }
  });

  return r;
}
