import { Router } from 'express';
import { authenticate } from '../services/auth.js';
import { audit } from '../db/index.js';

export default function authRoutes({ db }) {
  const r = Router();

  const homeFor = (user) => (user.role === 'instructor' ? '/instructor/schedule' : '/admin');

  // One login form for every staff role; /login is a friendly alias.
  r.get('/login', (req, res) => res.redirect('/admin/login'));

  r.get('/admin/login', (req, res) => {
    if (req.session.userId && res.locals.user) return res.redirect(homeFor(res.locals.user));
    res.render('login', { title: 'Staff login', error: null });
  });

  r.post('/admin/login', (req, res) => {
    const user = authenticate(db, req.body.email, req.body.password);
    if (!user) {
      return res.status(401).render('login', { title: 'Staff login', error: 'Invalid email or password.' });
    }
    req.session.userId = user.id;
    audit(db, user.email, 'login', 'user:' + user.id);
    res.redirect(homeFor(user));
  });

  r.post('/admin/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });

  return r;
}
