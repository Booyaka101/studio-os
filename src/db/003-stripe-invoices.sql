-- v3: membership renewals are recorded from Stripe invoices, keyed on the
-- invoice id so webhook retries can't record the same month twice.

ALTER TABLE payments ADD COLUMN stripe_invoice_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_invoice
  ON payments(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
