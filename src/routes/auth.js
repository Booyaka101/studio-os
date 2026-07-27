import { Router } from 'express';
import { authenticate } from '../services/auth.js';
import { audit } from '../db/index.js';

export default function authRoutes({ db }) {
  const r = Router();

  r.get('/admin/login', (req, res) => {
    if (req.session.userId) return res.redirect('/admin');
    res.render('login', { title: 'Staff login', error: null });
  });

  r.post('/admin/login', (req, res) => {
    const user = authenticate(db, req.body.email, req.body.password);
    if (!user) {
      return res.status(401).render('login', { title: 'Staff login', error: 'Invalid email or password.' });
    }
    req.session.userId = user.id;
    audit(db, user.email, 'login', 'user:' + user.id);
    res.redirect('/admin');
  });

  r.post('/admin/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });

  return r;
}
