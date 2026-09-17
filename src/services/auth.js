// Staff auth (bcryptjs) + HMAC magic-link tokens for client self-service.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getSetting } from '../db/index.js';

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function createUser(db, { email, password, name = '', role = 'staff' }) {
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)'
  ).run(email.trim().toLowerCase(), hashPassword(password), name, role);
  return info.lastInsertRowid;
}

// Returning early for an unknown email skips bcrypt entirely, which answers in
// microseconds instead of tens of milliseconds and turns the login form into a
// staff-email oracle. Comparing against a throwaway hash of the same cost keeps
// both paths the same shape. /magic-link already refuses to leak which emails
// exist; this is the same promise on the staff side.
const DUMMY_HASH = bcrypt.hashSync('password-that-is-never-valid', 10);

export function authenticate(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  const ok = verifyPassword(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  return user && ok ? user : null;
}

// --- magic links -----------------------------------------------------------

function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Signed token for a client, valid for ttlHours (default 7 days). */
export function makeMagicToken(db, clientId, { ttlHours = 24 * 7, now = Date.now() } = {}) {
  const secret = getSetting(db, 'app_secret');
  const expires = now + ttlHours * 3600000;
  const payload = `${clientId}.${expires}`;
  return `${payload}.${hmac(secret, payload)}`;
}

/** Returns clientId or null. Constant-time signature check. */
export function verifyMagicToken(db, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [idStr, expStr, sig] = parts;
  const secret = getSetting(db, 'app_secret');
  const expected = hmac(secret, `${idStr}.${expStr}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expStr) < now) return null;
  const id = Number(idStr);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// --- express middleware ----------------------------------------------------

export function requireStaff(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/admin/login');
}

/** Admin area: any logged-in owner/staff. Instructors get a hard 403. */
export function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId || !res.locals.user) return res.redirect('/admin/login');
  if (res.locals.user.role === 'instructor') {
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: 'Instructor accounts cannot access the admin area.',
    });
  }
  next();
}

/** Instructor portal: instructor role only; admins are sent to their own UI. */
export function requireInstructor(req, res, next) {
  if (!req.session || !req.session.userId || !res.locals.user) return res.redirect('/admin/login');
  if (res.locals.user.role !== 'instructor') return res.redirect('/admin');
  next();
}
