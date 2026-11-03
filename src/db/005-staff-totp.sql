ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT -1;
ALTER TABLE users ADD COLUMN totp_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_window_end INTEGER NOT NULL DEFAULT 0;

CREATE TABLE staff_login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_staff_challenges_user ON staff_login_challenges(user_id);

CREATE TABLE staff_totp_enrollments (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  secret TEXT NOT NULL,
  auth_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE staff_recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);
