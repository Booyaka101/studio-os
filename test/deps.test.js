// The Stripe and mailer suites both run against stand-ins: test/stripe.test.js
// injects a mock client, and every other test leaves SMTP_HOST unset so the
// mailer takes the outbox branch. Neither imports the real package, so a major
// bump can rewrite the API and still see a green suite. These tests pin the two
// bits of third-party behaviour the app cannot work without.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { createStripeService } from '../src/services/stripe.js';
import { createMailer } from '../src/services/mailer.js';

/**
 * Enough of an SMTP server for nodemailer to complete a send. Resolves with the
 * DATA payload it received. No STARTTLS advertised, so the client stays plain.
 */
function smtpSink() {
  let resolveData;
  const received = new Promise((r) => { resolveData = r; });
  const server = net.createServer((socket) => {
    let inData = false;
    let body = '';
    socket.write('220 sink.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      if (inData) {
        body += chunk.toString('utf8');
        if (body.includes('\r\n.\r\n')) {
          inData = false;
          socket.write('250 2.0.0 Ok: queued\r\n');
          resolveData(body.slice(0, body.indexOf('\r\n.\r\n')));
        }
        return;
      }
      for (const line of chunk.toString('utf8').split('\r\n').filter(Boolean)) {
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-sink.test\r\n250 8BITMIME\r\n');
        else if (verb === 'DATA') { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
        else socket.write('250 2.0.0 Ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return { server, received };
}

test('mailer: the real nodemailer SMTP path delivers when SMTP_HOST is set', async (t) => {
  const { server, received } = smtpSink();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const mailer = createMailer({
    env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port), SMTP_FROM: 'studio@test.hk' },
  });
  assert.equal(mailer.smtpConfigured, true);

  const ok = await mailer.send({ to: 'rider@test.hk', subject: 'Booked: Yoga', text: 'See you there' });
  assert.equal(ok, true, 'send() reported failure — it swallows errors, so check the mailer log');

  const raw = await received;
  assert.match(raw, /^To: rider@test\.hk$/m);
  assert.match(raw, /^From: studio@test\.hk$/m);
  assert.match(raw, /Booked: Yoga/);
  assert.match(raw, /See you there/);
});

test('mailer: send() resolves false rather than throwing when SMTP is unreachable', async () => {
  // A dead port: booking flows call send() fire-and-forget and must not 500.
  const mailer = createMailer({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' } });
  assert.equal(await mailer.send({ to: 'a@test.hk', subject: 's', text: 't' }), false);
});

test('stripe: the real SDK verifies a good webhook signature and rejects a forged one', async () => {
  const secret = 'whsec_deps_test';
  const svc = createStripeService({
    env: { STRIPE_SECRET_KEY: 'sk_test_deps', STRIPE_WEBHOOK_SECRET: secret },
  });

  const payload = JSON.stringify({
    id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const sign = (body) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  const event = await svc.parseWebhook(payload, `t=${ts},v1=${sign(payload)}`);
  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(event.data.object.id, 'cs_1');

  // A payload swapped after signing must not verify — this is the only thing
  // stopping anyone who knows the URL from granting themselves a membership.
  const forged = payload.replace('cs_1', 'cs_forged');
  await assert.rejects(
    () => svc.parseWebhook(forged, `t=${ts},v1=${sign(payload)}`),
    /signature/i,
  );
  await assert.rejects(() => svc.parseWebhook(payload, `t=${ts},v1=deadbeef`), /signature/i);
});

test('stripe: the real SDK still exposes the Checkout surface the mock stands in for', async () => {
  const svc = createStripeService({ env: { STRIPE_SECRET_KEY: 'sk_test_deps' } });
  // Reaches into the client without a network call: a rename of
  // checkout.sessions.create is a TypeError here, not a runtime 500 in prod.
  const Stripe = (await import('stripe')).default;
  const client = new Stripe('sk_test_deps');
  assert.equal(typeof client.checkout.sessions.create, 'function');
  assert.equal(typeof client.webhooks.constructEvent, 'function');
  assert.equal(svc.configured, true);
});
