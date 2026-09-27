-- v4: a drop-in paid at the studio is only owed while its booking stands, so
-- the pending payment remembers which booking it's for.

ALTER TABLE payments ADD COLUMN booking_id INTEGER REFERENCES bookings(id);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id) WHERE booking_id IS NOT NULL;
