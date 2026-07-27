// Mindbody importer: CSV parsing, fixture import, idempotency, mapping
// overrides, dry-run, and the CLI script end-to-end. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/index.js';
import { parseCsv, importClients, importPasses } from '../src/services/importer.js';
import { testDb } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const clientsCsv = fs.readFileSync(path.join(FIXTURES, 'mindbody-clients.csv'), 'utf8');
const passesCsv = fs.readFileSync(path.join(FIXTURES, 'mindbody-passes.csv'), 'utf8');

test('parseCsv handles quoted fields, embedded commas and doubled quotes', () => {
  const rows = parseCsv('A,B\n"x, y","he said ""hi"""\nplain,2');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].A, 'x, y');
  assert.equal(rows[0].B, 'he said "hi"');
  assert.equal(rows[1].A, 'plain');
});

test('clients fixture import: creates valid rows, skips missing email, normalizes', () => {
  const db = testDb();
  const r = importClients(db, clientsCsv);
  assert.equal(r.created, 7, 'seven rows have valid emails');
  assert.equal(r.skipped, 1, 'David Ng has no email');
  assert.equal(r.updated, 0);

  // quoted comma inside a name survives
  const jason = db.prepare('SELECT * FROM clients WHERE email = ?').get('jason.obrien@example.com');
  assert.equal(jason.name, "Jason O'Brien, Jr.");
  assert.equal(jason.source, 'import');

  // uppercase email in the export is stored lowercase
  const mei = db.prepare('SELECT * FROM clients WHERE email = ?').get('mei.cheung@example.com');
  assert.ok(mei, 'MEI.CHEUNG@Example.com normalized to lowercase');

  // waiver column mapped: Yes → signed, No → not signed
  const wing = db.prepare('SELECT * FROM clients WHERE email = ?').get('wingyan.chan@example.com');
  assert.ok(wing.waiver_signed_at, 'Liability Waiver=Yes sets waiver_signed_at');
  const siufung = db.prepare('SELECT * FROM clients WHERE email = ?').get('siufung.lee@example.com');
  assert.equal(siufung.waiver_signed_at, null, 'Liability Waiver=No leaves waiver unsigned');
});

test('clients import is idempotent by email: re-run updates, never duplicates', () => {
  const db = testDb();
  importClients(db, clientsCsv);
  const before = db.prepare('SELECT COUNT(*) c FROM clients').get().c;

  const r2 = importClients(db, clientsCsv);
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 7);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, before, 'no duplicates');

  // an updated export (new phone) updates in place, and blank columns do not wipe data
  const changed = 'First Name,Last Name,Email,Mobile Phone\nWing Yan,Chan,wingyan.chan@example.com,+852 5555 0000\n';
  const r3 = importClients(db, changed);
  assert.equal(r3.updated, 1);
  const wing = db.prepare('SELECT * FROM clients WHERE email = ?').get('wingyan.chan@example.com');
  assert.equal(wing.phone, '+852 5555 0000');
  assert.match(wing.notes, /morning classes/, 'notes kept when re-import omits the column');
});

test('clients dry-run reports work but writes nothing', () => {
  const db = testDb();
  const r = importClients(db, clientsCsv, { dryRun: true });
  assert.equal(r.created, 7);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 0, 'dry run wrote nothing');
});

test('passes fixture import: attaches by email, parses money/dates, auto-creates unknown clients', () => {
  const db = testDb();
  importClients(db, clientsCsv);
  const r = importPasses(db, passesCsv);
  assert.equal(r.created, 6);
  assert.equal(r.skipped, 1, 'Walk In row has no email');
  assert.equal(r.clientsCreated, 1, 'Priya Sharma not in clients export → bare client created');

  const wing = db.prepare('SELECT * FROM clients WHERE email = ?').get('wingyan.chan@example.com');
  const pass = db.prepare('SELECT * FROM passes WHERE client_id = ?').get(wing.id);
  assert.equal(pass.credits_remaining, 7);
  assert.equal(pass.credits_total, 10);
  assert.equal(pass.expires_on, '2026-10-31', 'M/D/YYYY normalized');
  assert.equal(pass.price_paid_cents, 150000, '"$1,500.00" parsed to cents');
  assert.equal(pass.source, 'import');

  // ISO expiration passes through
  const emily = db.prepare('SELECT * FROM clients WHERE email = ?').get('emily.tsang@example.com');
  const epass = db.prepare('SELECT * FROM passes WHERE client_id = ?').get(emily.id);
  assert.equal(epass.expires_on, '2026-12-31');

  // two different pricing options for the same client → two passes
  const kaming = db.prepare('SELECT * FROM clients WHERE email = ?').get('kaming.wong@example.com');
  const kpasses = db.prepare('SELECT * FROM passes WHERE client_id = ? ORDER BY name').all(kaming.id);
  assert.equal(kpasses.length, 2);
  assert.equal(kpasses.find((p) => p.name === '5 Class Intro Pack').credits_remaining, 0);

  const priya = db.prepare('SELECT * FROM clients WHERE email = ?').get('priya.sharma@example.com');
  assert.equal(priya.name, 'Priya Sharma');
  assert.equal(priya.source, 'import');
});

test('passes import is idempotent: re-run updates remaining, never duplicates', () => {
  const db = testDb();
  importClients(db, clientsCsv);
  importPasses(db, passesCsv);
  const before = db.prepare('SELECT COUNT(*) c FROM passes').get().c;

  const r2 = importPasses(db, passesCsv);
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 6);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM passes').get().c, before, 'no duplicate passes');

  // a newer export with fewer remaining credits updates the same pass row
  const newer = 'Client,Email,Pricing Option,Remaining,Total,Expiration,Price Paid\n'
    + 'Wing Yan Chan,wingyan.chan@example.com,10 Class Pack,5,10,10/31/2026,"$1,500.00"\n';
  const r3 = importPasses(db, newer);
  assert.equal(r3.updated, 1);
  assert.equal(r3.created, 0);
  const wing = db.prepare('SELECT * FROM clients WHERE email = ?').get('wingyan.chan@example.com');
  const pass = db.prepare("SELECT * FROM passes WHERE client_id = ? AND name = '10 Class Pack'").get(wing.id);
  assert.equal(pass.credits_remaining, 5);
});

test('column mapping overrides let non-standard exports import', () => {
  const db = testDb();
  const csv = 'Vorname,Nachname,E-Mail-Adresse\nHans,Muller,hans@example.com\n';
  const r = importClients(db, csv, {
    mapping: {
      firstName: ['Vorname'], lastName: ['Nachname'], email: ['E-Mail-Adresse'],
      phone: [], notes: [], waiverSigned: [],
    },
  });
  assert.equal(r.created, 1);
  assert.equal(db.prepare('SELECT name FROM clients WHERE email = ?').get('hans@example.com').name, 'Hans Muller');
});

test('CLI script: dry-run writes nothing, real run imports, re-run is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-import-'));
  const dbPath = path.join(dir, 'studio.db');
  const script = path.join(__dirname, '..', 'scripts', 'import-mindbody.mjs');
  const run = (extra) => spawnSync(process.execPath, [
    script,
    '--clients', path.join(FIXTURES, 'mindbody-clients.csv'),
    '--passes', path.join(FIXTURES, 'mindbody-passes.csv'),
    '--db', dbPath, ...extra,
  ], { encoding: 'utf8' });

  const dry = run(['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN/);
  let db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 0, 'dry run wrote nothing');
  db.close();

  const real = run([]);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /7 created/);
  const rerun = run([]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /0 created, 7 updated/);

  db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, 8, '7 from clients + Priya');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM passes').get().c, 6);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
