// Email delivery. SMTP via nodemailer when configured; otherwise every message
// is written to data/outbox/*.eml so flows stay fully testable offline.
import fs from 'node:fs';
import path from 'node:path';

export function createMailer({ env = process.env, outboxDir } = {}) {
  const smtpConfigured = Boolean(env.SMTP_HOST);
  const outbox = outboxDir || path.join(process.cwd(), 'data', 'outbox');
  let transportPromise = null;

  async function getTransport() {
    if (!transportPromise) {
      const nodemailer = (await import('nodemailer')).default;
      transportPromise = Promise.resolve(nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 587),
        secure: Number(env.SMTP_PORT) === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      }));
    }
    return transportPromise;
  }

  return {
    smtpConfigured,
    /** Fire-and-forget safe: never throws, logs failures. */
    async send({ to, subject, text }) {
      const from = env.SMTP_FROM || 'studio-os@localhost';
      try {
        if (smtpConfigured) {
          const t = await getTransport();
          await t.sendMail({ from, to, subject, text });
        } else {
          fs.mkdirSync(outbox, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const safeTo = String(to).replace(/[^a-z0-9@._-]/gi, '_');
          const eml = [
            `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
            `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8', '', text,
          ].join('\r\n');
          fs.writeFileSync(path.join(outbox, `${stamp}_${safeTo}.eml`), eml);
        }
        return true;
      } catch (err) {
        console.error('[mailer] send failed:', err.message);
        return false;
      }
    },
  };
}

// --- templates (plain text, keep it simple and readable) -------------------

export const emails = {
  bookingConfirmation({ studio, clientName, className, when, paidWith, magicUrl }) {
    return {
      subject: `Booked: ${className} — ${when}`,
      text: `Hi ${clientName},\n\nYou're booked for ${className} on ${when} at ${studio}.\nPayment: ${paidWith}.\n\nManage your bookings: ${magicUrl}\n\nSee you there!\n${studio}`,
    };
  },
  waitlisted({ studio, clientName, className, when, magicUrl }) {
    return {
      subject: `Waitlisted: ${className} — ${when}`,
      text: `Hi ${clientName},\n\nThe ${className} class on ${when} is full — you're on the waitlist. We'll email you if a spot opens.\n\nManage your bookings: ${magicUrl}\n\n${studio}`,
    };
  },
  cancellation({ studio, clientName, className, when, refunded }) {
    return {
      subject: `Cancelled: ${className} — ${when}`,
      text: `Hi ${clientName},\n\nYour booking for ${className} on ${when} was cancelled.${refunded ? ' Your credit has been returned.' : ''}\n\n${studio}`,
    };
  },
  waitlistPromotion({ studio, clientName, className, when, magicUrl }) {
    return {
      subject: `You're in! ${className} — ${when}`,
      text: `Hi ${clientName},\n\nA spot opened up: you're now booked for ${className} on ${when}.\n\nCan't make it? Cancel here: ${magicUrl}\n\n${studio}`,
    };
  },
  classCancelled({ studio, clientName, className, when }) {
    return {
      subject: `Class cancelled: ${className} — ${when}`,
      text: `Hi ${clientName},\n\nSorry — ${className} on ${when} has been cancelled by the studio. Any credit used has been returned.\n\n${studio}`,
    };
  },
  magicLink({ studio, clientName, magicUrl }) {
    return {
      subject: `${studio}: your booking management link`,
      text: `Hi ${clientName},\n\nUse this link to view and manage your bookings:\n${magicUrl}\n\nThe link is valid for 7 days.\n\n${studio}`,
    };
  },
};
