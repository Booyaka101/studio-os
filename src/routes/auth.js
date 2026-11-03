import { Router } from 'express';
import crypto from 'node:crypto';
import { authenticate, verifyPassword, requireStaff, establishStaffSession } from '../services/auth.js';
import { audit } from '../db/index.js';

export default function authRoutes({ db, totp, now }) {
  const r = Router();

  const homeFor = (user) => (user.role === 'instructor' ? '/instructor/schedule' : '/admin');
  const noStore = (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    next();
  };
  r.use('/admin/login', noStore);

  // One login form for every staff role; /login is a friendly alias.
  r.get('/login', (req, res) => res.redirect('/admin/login'));

  r.get('/admin/login', (req, res) => {
    if (req.session.userId && res.locals.user) return res.redirect(homeFor(res.locals.user));
    res.render('login', { title: 'Staff login', error: null });
  });

  r.post('/admin/login', (req, res) => {
    totp.cancelChallenge(req.session.pendingLogin);
    const csrf = req.session.csrf;
    req.session = { csrf };
    const user = authenticate(db, req.body?.email, req.body?.password);
    if (!user) {
      return res.status(401).render('login', { title: 'Staff login', error: 'Invalid email or password.' });
    }
    if (user.totp_secret) {
      const token = totp.createChallenge(user.id);
      if (!token) return res.status(401).render('login', { title: 'Staff login', error: 'Unable to sign in. Please wait and try again.' });
      req.session = { pendingLogin: token, csrf: crypto.randomBytes(24).toString('hex') };
      return res.redirect('/admin/login/verify');
    }
    establishStaffSession(req, user, now());
    audit(db, user.email, 'login', 'user:' + user.id);
    res.redirect(homeFor(user));
  });

  r.get('/admin/login/verify', (req, res) => {
    if (!req.session.pendingLogin) return res.redirect('/admin/login');
    res.render('login_verify', { title: 'Verify sign-in', error: null });
  });

  r.post('/admin/login/verify', (req, res) => {
    const user = totp.completeChallenge(req.session.pendingLogin, req.body?.code);
    if (!user) return res.status(401).render('login_verify', {
      title: 'Verify sign-in', error: 'Invalid or expired verification. Use a fresh code or start sign-in again. After five failed attempts, wait 15 minutes.',
    });
    establishStaffSession(req, user, now());
    res.redirect(homeFor(user));
  });

  r.use('/staff/security', requireStaff, noStore);
  const accountFor = (req) => db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  function securityPage(req, res, { error = null, codes = null, status = 200 } = {}) {
    const account = accountFor(req);
    const secret = totp.configured ? totp.enrollmentSecret(account.id, req.session.enrollment) : null;
    const label = encodeURIComponent(`Studio OS:${account.email}`);
    const uri = secret ? `otpauth://totp/${label}?secret=${secret}&issuer=Studio%20OS&algorithm=SHA1&digits=6&period=30` : null;
    res.status(status).render('staff_security', {
      title: 'Account security', enabled: Boolean(account.totp_secret), configured: totp.configured,
      secret, uri, error, codes,
      remaining: db.prepare('SELECT count(*) AS n FROM staff_recovery_codes WHERE user_id = ?').get(account.id).n,
    });
  }
  const passwordOk = (req) => typeof req.body?.password === 'string'
    && verifyPassword(req.body.password, accountFor(req).password_hash);
  const fail = (req, res) => securityPage(req, res, { status: 400, error: 'Verification failed. Check your password and use a fresh code. After five failed codes, wait 15 minutes.' });

  r.get('/staff/security', (req, res) => securityPage(req, res));
  r.post('/staff/security/cancel', (req, res) => {
    totp.cancelEnrollment(req.session.userId, req.session.enrollment);
    delete req.session.enrollment;
    res.redirect('/staff/security');
  });
  r.post('/staff/security/setup', (req, res) => {
    if (!totp.configured || !passwordOk(req)) return fail(req, res);
    const token = totp.startEnrollment(req.session.userId, req.session.authVersion);
    if (!token) return fail(req, res);
    req.session.enrollment = token;
    res.redirect('/staff/security');
  });
  r.post('/staff/security/enable', (req, res) => {
    if (!totp.configured || !passwordOk(req)) return fail(req, res);
    const result = totp.enable(req.session.userId, req.session.enrollment, req.body?.code);
    if (!result) return fail(req, res);
    establishStaffSession(req, result.user, now());
    securityPage(req, res, { codes: result.codes });
  });
  for (const action of ['disable', 'regenerate']) {
    r.post(`/staff/security/${action}`, (req, res) => {
      if (!passwordOk(req)) return fail(req, res);
      const result = totp.change(req.session.userId, req.body?.code, action, req.session.authVersion);
      if (!result) return fail(req, res);
      establishStaffSession(req, result.user, now());
      if (result.codes) return securityPage(req, res, { codes: result.codes });
      req.session.flash = 'Two-factor authentication disabled. Other staff sessions have been signed out.';
      res.redirect('/staff/security');
    });
  }

  r.post('/admin/logout', (req, res) => {
    if (res.locals.user) totp.signOutAll(req.session.userId, req.session.authVersion);
    totp.cancelChallenge(req.session.pendingLogin);
    req.session = null;
    res.redirect('/');
  });

  return r;
}
