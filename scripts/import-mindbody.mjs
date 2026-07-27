#!/usr/bin/env node
// Mindbody CSV importer CLI.
//
// Usage:
//   node scripts/import-mindbody.mjs --clients clients.csv [--dry-run]
//   node scripts/import-mindbody.mjs --passes pricing-options.csv [--dry-run]
//   node scripts/import-mindbody.mjs --clients c.csv --passes p.csv \
//        [--mapping mapping.json] [--db data/studio.db]
//
// The mapping file is JSON: { "clients": { field: ["Column", ...] },
// "passes": { ... } } — keys you provide override the defaults, everything
// else keeps its default candidates. Re-running is safe: clients are matched
// by email and updated, never duplicated.
import fs from 'node:fs';
import process from 'node:process';
import { openDb } from '../src/db/index.js';
import { importClients, importPasses, DEFAULT_MAPPING } from '../src/services/importer.js';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clients') args.clients = argv[++i];
    else if (a === '--passes') args.passes = argv[++i];
    else if (a === '--mapping') args.mapping = argv[++i];
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--dry-run' || a === '--dryrun') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Mindbody CSV importer

Usage:
  node scripts/import-mindbody.mjs --clients clients.csv [--passes passes.csv]
                                   [--mapping mapping.json] [--db data/studio.db]
                                   [--dry-run]

Options:
  --clients FILE   Mindbody clients export (First Name, Last Name, Email, ...)
  --passes FILE    Mindbody pricing-options export (Client, Email, Pricing Option,
                   Remaining, Expiration, ...)
  --mapping FILE   JSON column-mapping overrides (merged over sane defaults)
  --db FILE        SQLite database path (default: data/studio.db or DB_PATH env)
  --dry-run        Print what would happen without writing anything

Import clients BEFORE passes so passes attach to full client records
(passes for unknown emails still work — a bare client is created from the email).`);
}

function loadMapping(file) {
  if (!file) return { clients: DEFAULT_MAPPING.clients, passes: DEFAULT_MAPPING.passes };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    clients: { ...DEFAULT_MAPPING.clients, ...(raw.clients || {}) },
    passes: { ...DEFAULT_MAPPING.passes, ...(raw.passes || {}) },
  };
}

function report(label, result) {
  console.log(`\n${label}: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`
    + (result.clientsCreated ? `, ${result.clientsCreated} clients auto-created` : ''));
  for (const row of result.rows) {
    if (row.action === 'skip') {
      console.log(`  skip    ${JSON.stringify(row.row).slice(0, 100)}  (${row.reason})`);
    } else {
      console.log(`  ${row.action.padEnd(7)} ${row.email}  ${row.name || row.passName || ''}${'remaining' in row ? `  (${row.remaining} remaining)` : ''}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.clients && !args.passes)) {
  usage();
  process.exit(args.help && (args.clients || args.passes) ? 1 : args.help ? 0 : 1);
}

let mapping;
try {
  mapping = loadMapping(args.mapping);
} catch (err) {
  console.error(`Could not read mapping file: ${err.message}`);
  process.exit(1);
}

const db = openDb(args.db);
if (args.dryRun) console.log('DRY RUN — nothing will be written.');

try {
  if (args.clients) {
    const csv = fs.readFileSync(args.clients, 'utf8');
    report(`Clients (${args.clients})`, importClients(db, csv, { mapping: mapping.clients, dryRun: args.dryRun }));
  }
  if (args.passes) {
    const csv = fs.readFileSync(args.passes, 'utf8');
    report(`Passes (${args.passes})`, importPasses(db, csv, { mapping: mapping.passes, dryRun: args.dryRun }));
  }
} catch (err) {
  console.error(`Import failed: ${err.message}`);
  process.exit(1);
} finally {
  db.close();
}
