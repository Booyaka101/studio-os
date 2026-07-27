import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = [
  { version: 1, file: 'schema.sql' },
];

const DEFAULT_SETTINGS = {
  studio_name: '',
  timezone: 'Asia/Hong_Kong',
  currency: 'HKD',
  cancellation_window_hours: '12',
  late_cancel_policy: 'forfeit', // forfeit | refund
  waiver_markdown: '## Liability Waiver\n\nI understand that participation in classes involves physical activity and I take part at my own risk. I confirm I am in good health and will inform the instructor of any injuries or conditions.\n\nBy checking the box I agree to this waiver.',
  setup_complete: '0',
  horizon_weeks: '8',
};

/**
 * Open (or create) the database, enable WAL, run migrations, seed defaults.
 * @param {string} [dbPath] file path or ':memory:' (tests)
 */
export function openDb(dbPath) {
  const file = dbPath || process.env.DB_PATH || path.join(process.cwd(), 'data', 'studio.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const sql = fs.readFileSync(path.join(__dirname, m.file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(m.version, new Date().toISOString());
    })();
  }
  // seed default settings (INSERT OR IGNORE keeps existing values)
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  // app secret: generated once, persisted, overridable via env
  if (!process.env.APP_SECRET) {
    ins.run('app_secret', crypto.randomBytes(32).toString('hex'));
  }
}

export function getSetting(db, key, fallback = '') {
  if (key === 'app_secret' && process.env.APP_SECRET) return process.env.APP_SECRET;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function allSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  if (process.env.APP_SECRET) out.app_secret = process.env.APP_SECRET;
  return out;
}

export function audit(db, who, action, entity = '') {
  db.prepare('INSERT INTO audit_log (who, action, entity, at) VALUES (?, ?, ?, ?)')
    .run(who || '', action, entity, new Date().toISOString());
}
