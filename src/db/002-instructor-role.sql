-- v2: instructor logins. Adds 'instructor' to the users role CHECK (SQLite
-- cannot alter a CHECK in place, so the table is rebuilt — no FKs reference
-- users) and a many-to-many instructor↔class assignment table.

CREATE TABLE users_v2 (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','staff','instructor')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO users_v2 (id, email, password_hash, name, role, created_at)
  SELECT id, email, password_hash, name, role, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;

-- instructor_id → users.id (role 'instructor'); class_id → class_instances.id.
-- CASCADE so deleting an account or a not-yet-booked future instance (rule
-- delete) never strands or blocks on an assignment row.
CREATE TABLE IF NOT EXISTS instructor_class_assignments (
  instructor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id      INTEGER NOT NULL REFERENCES class_instances(id) ON DELETE CASCADE,
  PRIMARY KEY (instructor_id, class_id)
);
CREATE INDEX IF NOT EXISTS idx_ica_class ON instructor_class_assignments(class_id);
