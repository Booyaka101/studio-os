// Mindbody CSV importer core. Used by scripts/import-mindbody.mjs and the
// admin import page. Idempotent by client email: re-running updates, never
// duplicates. No external CSV dependency — small RFC-4180-ish parser below.

/** Parse CSV text into an array of row objects keyed by header. Handles quoted
 *  fields, embedded commas/newlines, and doubled quotes. */
export function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  const src = String(text).replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
}

// Default column mappings for standard Mindbody exports. Override via a JSON
// mapping file ({ clients: {...}, passes: {...} }).
export const DEFAULT_MAPPING = {
  clients: {
    firstName: ['First Name', 'FirstName', 'First'],
    lastName: ['Last Name', 'LastName', 'Last'],
    email: ['Email', 'Email Address', 'E-mail'],
    phone: ['Phone', 'Mobile Phone', 'Cell Phone', 'Home Phone'],
    notes: ['Notes'],
    waiverSigned: ['Liability Waiver', 'Waiver Signed', 'Liability Release'],
  },
  passes: {
    email: ['Email', 'Client Email', 'Email Address'],
    clientName: ['Client', 'Client Name', 'Name'],
    passName: ['Pricing Option', 'Service Name', 'Pricing Option Name'],
    remaining: ['Remaining', 'Sessions Remaining', 'Count Remaining', 'Remaining Sessions'],
    total: ['Total', 'Session Count', 'Total Sessions'],
    expiration: ['Expiration', 'Expiration Date', 'Exp Date', 'Expires'],
    pricePaid: ['Price Paid', 'Amount Paid', 'Price'],
  },
};

function pick(row, candidates) {
  for (const c of candidates) {
    if (c in row && row[c] !== '') return row[c];
  }
  // case-insensitive fallback
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const c of candidates) {
    const v = lower[c.toLowerCase()];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

function normalizeDate(s) {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // Mindbody M/D/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function parseMoneyCents(s) {
  if (!s) return 0;
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Import Mindbody clients CSV. Returns { created, updated, skipped, rows:[...] }.
 * dryRun: report what would happen without writing.
 */
export function importClients(db, csvText, { mapping = DEFAULT_MAPPING.clients, dryRun = false } = {}) {
  const rows = parseCsv(csvText);
  const result = { created: 0, updated: 0, skipped: 0, rows: [] };
  const work = db.transaction(() => {
    for (const row of rows) {
      const email = pick(row, mapping.email).toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        result.skipped++;
        result.rows.push({ action: 'skip', reason: 'missing/invalid email', row });
        continue;
      }
      const first = pick(row, mapping.firstName);
      const last = pick(row, mapping.lastName);
      const name = `${first} ${last}`.trim() || email.split('@')[0];
      const phone = pick(row, mapping.phone);
      const notes = pick(row, mapping.notes);
      const waiverRaw = pick(row, mapping.waiverSigned).toLowerCase();
      const waiverSigned = ['yes', 'y', 'true', 'signed', '1'].includes(waiverRaw);

      const existing = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
      if (existing) {
        if (!dryRun) {
          db.prepare(
            `UPDATE clients SET name = ?, phone = CASE WHEN ? != '' THEN ? ELSE phone END,
             notes = CASE WHEN ? != '' THEN ? ELSE notes END,
             waiver_signed_at = COALESCE(waiver_signed_at, ?)
             WHERE id = ?`
          ).run(name, phone, phone, notes, notes,
            waiverSigned ? new Date().toISOString() : null, existing.id);
        }
        result.updated++;
        result.rows.push({ action: 'update', email, name });
      } else {
        if (!dryRun) {
          db.prepare(
            "INSERT INTO clients (name, email, phone, notes, waiver_signed_at, source) VALUES (?, ?, ?, ?, ?, 'import')"
          ).run(name, email, phone, notes, waiverSigned ? new Date().toISOString() : null);
        }
        result.created++;
        result.rows.push({ action: 'create', email, name });
      }
    }
  });
  work();
  return result;
}

/**
 * Import Mindbody pricing-option/pass CSV. Clients must exist (or are created
 * as bare records from the email). Idempotent: a pass identified by
 * (client, name, expiration) is updated in place, never duplicated.
 */
export function importPasses(db, csvText, { mapping = DEFAULT_MAPPING.passes, dryRun = false } = {}) {
  const rows = parseCsv(csvText);
  const result = { created: 0, updated: 0, skipped: 0, clientsCreated: 0, rows: [] };
  const work = db.transaction(() => {
    for (const row of rows) {
      const email = pick(row, mapping.email).toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        result.skipped++;
        result.rows.push({ action: 'skip', reason: 'missing/invalid email', row });
        continue;
      }
      const passName = pick(row, mapping.passName) || 'Imported pass';
      const remaining = Math.max(0, parseInt(pick(row, mapping.remaining), 10) || 0);
      const total = Math.max(remaining, parseInt(pick(row, mapping.total), 10) || remaining);
      const expiresOn = normalizeDate(pick(row, mapping.expiration));
      const priceCents = parseMoneyCents(pick(row, mapping.pricePaid));

      let client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
      if (!client) {
        const name = pick(row, mapping.clientName) || email.split('@')[0];
        if (!dryRun) {
          const info = db.prepare(
            "INSERT INTO clients (name, email, source) VALUES (?, ?, 'import')"
          ).run(name, email);
          client = { id: info.lastInsertRowid };
        } else {
          client = { id: null };
        }
        result.clientsCreated++;
      }

      const existing = client.id === null ? null : db.prepare(
        `SELECT * FROM passes WHERE client_id = ? AND name = ? AND source = 'import'
         AND (expires_on IS ? OR expires_on = ?)`
      ).get(client.id, passName, expiresOn, expiresOn);
      if (existing) {
        if (!dryRun) {
          db.prepare('UPDATE passes SET credits_remaining = ?, credits_total = ? WHERE id = ?')
            .run(remaining, total, existing.id);
        }
        result.updated++;
        result.rows.push({ action: 'update', email, passName, remaining });
      } else {
        if (!dryRun) {
          db.prepare(
            `INSERT INTO passes (client_id, name, credits_total, credits_remaining, expires_on, price_paid_cents, source)
             VALUES (?, ?, ?, ?, ?, ?, 'import')`
          ).run(client.id, passName, total, remaining, expiresOn, priceCents);
        }
        result.created++;
        result.rows.push({ action: 'create', email, passName, remaining });
      }
    }
  });
  work();
  return result;
}
