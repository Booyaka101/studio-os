import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/services/auth.js';
import { createTotpService, generateSecret, totpAt } from '../src/services/totp.js';
import { testDb, csrfToken } from './helpers.js';

const env = { TOTP_ENCRYPTION_KEY: 'ab'.repeat(32) };
const password = 'correct horse battery';
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
function fixture(role = 'owner') {
  const db = testDb();
  const id = createUser(db, { email: 'staff@test.test', password, role });
  let clock = 1800000000000;
  const now = () => clock;
  const totp = createTotpService({ db, env, now });
  const app = createApp({ db, env, now });
  return { db, id, app, totp, now, advance: (ms = 30000) => { clock += ms; } };
}
function enroll(f) {
  const version = f.db.prepare('SELECT auth_version FROM users WHERE id = ?').get(f.id).auth_version;
  const token = f.totp.startEnrollment(f.id, version);
  const secret = f.totp.enrollmentSecret(f.id, token);
  const result = f.totp.enable(f.id, token, totpAt(secret, f.now()));
  assert.ok(result);
  return { secret, codes: result.codes, token };
}
const post = (agent, url, fields) => agent.post(url).type('form').send(fields);
async function login(agent) {
  const _csrf = await csrfToken(agent, '/admin/login');
  return post(agent, '/admin/login', { _csrf, email: 'staff@test.test', password });
}

for (const [seconds, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
  [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
  test(`TOTP matches RFC 6238 SHA-1 vector at ${seconds}`, () => {
    assert.equal(totpAt(RFC_SECRET, seconds * 1000), expected);
  });
}

test('enrollment encrypts secrets, binds to user/nonce and shows recovery codes only once', () => {
  const f = fixture();
  const otherId = createUser(f.db, { email: 'other@test.test', password });
  const token = f.totp.startEnrollment(f.id, 0);
  const secret = f.totp.enrollmentSecret(f.id, token);
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.notEqual(secret, generateSecret());
  assert.equal(f.totp.enrollmentSecret(otherId, token), null);
  assert.equal(f.totp.enrollmentSecret(f.id, 'wrong'), null);
  assert.equal(f.totp.enable(f.id, token, 'bad'), null);
  const result = f.totp.enable(f.id, token, totpAt(secret, f.now()));
  assert.equal(result.codes.length, 10);
  assert.equal(new Set(result.codes).size, 10);
  assert.equal(result.user.auth_version, 1);
  assert.equal(f.totp.enrollmentSecret(f.id, token), null);
  assert.equal(f.totp.enable(f.id, token, totpAt(secret, f.now())), null);
  const account = f.db.prepare('SELECT * FROM users WHERE id = ?').get(f.id);
  assert.ok(!account.totp_secret.includes(secret));
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM staff_recovery_codes').all()).includes(result.codes[0].replaceAll('-', '')));
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM audit_log').all()).includes(secret));
  assert.equal(f.totp.startEnrollment(f.id, 0), null);
});

test('TOTP accepts adjacent windows once, rejects malformed, old and replayed codes', () => {
  const f = fixture();
  const { secret } = enroll(f);
  let challenge = f.totp.createChallenge(f.id);
  assert.equal(f.totp.completeChallenge(challenge, totpAt(secret, f.now())), null, 'enrollment code is consumed');
  for (const invalid of ['', '123', '1234567', ' 123456', ['123456'], {}, null]) {
    assert.equal(f.totp.completeChallenge(challenge, invalid), null);
    f.advance(15 * 60000);
    challenge = f.totp.createChallenge(f.id);
  }
  const code = totpAt(secret, f.now() + 30000);
  assert.ok(f.totp.completeChallenge(challenge, code));
  assert.equal(f.totp.completeChallenge(challenge, code), null, 'challenge cannot be replayed');
  challenge = f.totp.createChallenge(f.id);
  assert.equal(f.totp.completeChallenge(challenge, code), null);
  f.advance(90000);
  assert.equal(f.totp.completeChallenge(challenge, code), null);
  assert.ok(f.totp.completeChallenge(challenge, totpAt(secret, f.now() - 30000)));
});

test('expired enrollment and challenge cannot be revived from old cookies', () => {
  const f = fixture();
  const token = f.totp.startEnrollment(f.id, 0);
  const secret = f.totp.enrollmentSecret(f.id, token);
  f.advance(10 * 60000);
  assert.equal(f.totp.enrollmentSecret(f.id, token), null);
  assert.equal(f.totp.enable(f.id, token, totpAt(secret, f.now())), null);
  const active = enroll(f);
  const challenge = f.totp.createChallenge(f.id);
  f.advance(10 * 60000);
  assert.equal(f.totp.completeChallenge(challenge, totpAt(active.secret, f.now())), null);
});

test('five failed codes lock the account across challenges and app instances', () => {
  const f = fixture();
  const { codes } = enroll(f);
  const challenge = f.totp.createChallenge(f.id);
  for (let i = 0; i < 5; i++) assert.equal(f.totp.completeChallenge(challenge, 'invalid'), null);
  const second = createTotpService({ db: f.db, env, now: f.now });
  assert.equal(second.createChallenge(f.id), null);
  assert.equal(second.completeChallenge(challenge, codes[0]), null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM staff_recovery_codes').get().n, 10);
  f.advance(15 * 60000);
  assert.ok(second.completeChallenge(second.createChallenge(f.id), codes[0]));
});

test('recovery consumption, regeneration, disable and version invalidation are atomic', () => {
  const f = fixture();
  const { codes } = enroll(f);
  const challenge = f.totp.createChallenge(f.id);
  assert.ok(f.totp.completeChallenge(challenge, codes[0].toUpperCase()));
  assert.equal(f.totp.completeChallenge(f.totp.createChallenge(f.id), codes[0]), null);
  const oldChallenge = f.totp.createChallenge(f.id);
  assert.equal(f.totp.change(f.id, codes[1], 'regenerate', 0), null, 'stale sessions rejected');
  const next = f.totp.change(f.id, codes[1], 'regenerate', 1);
  assert.equal(next.user.auth_version, 2);
  assert.equal(f.totp.completeChallenge(oldChallenge, codes[2]), null);
  assert.equal(f.totp.completeChallenge(f.totp.createChallenge(f.id), codes[2]), null);
  assert.equal(f.totp.change(f.id, next.codes[0], 'disable', 2).user.totp_secret, null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM staff_recovery_codes').get().n, 0);
});

test('missing, wrong and tampered encryption keys fail closed', () => {
  const f = fixture();
  const { codes } = enroll(f);
  assert.throws(() => createTotpService({ db: f.db, env: {}, now: f.now }), /required/);
  assert.throws(() => createTotpService({ db: f.db, env: { TOTP_ENCRYPTION_KEY: 'invalid' }, now: f.now }), /64 hexadecimal/);
  const wrong = createTotpService({ db: f.db, env: { TOTP_ENCRYPTION_KEY: 'cd'.repeat(32) }, now: f.now });
  assert.equal(wrong.completeChallenge(wrong.createChallenge(f.id), '123456'), null);
  assert.ok(wrong.completeChallenge(wrong.createChallenge(f.id), codes[0]), 'recovery code does not depend on decryption');
  const secondId = createUser(f.db, { email: 'other@test.test', password });
  const ciphertext = f.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(f.id).totp_secret;
  f.db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(ciphertext, secondId);
  assert.equal(f.totp.completeChallenge(f.totp.createChallenge(secondId), '123456'), null);
});

for (const role of ['owner', 'staff', 'instructor']) {
  test(`${role}: password alone cannot pass 2FA; verified session keeps role boundaries`, async () => {
    const f = fixture(role);
    const { secret } = enroll(f);
    const agent = request.agent(f.app);
    const first = await login(agent);
    assert.equal(first.headers.location, '/admin/login/verify');
    assert.equal((await agent.get('/admin')).headers.location, '/admin/login');
    assert.equal((await agent.get('/instructor/schedule')).headers.location, '/admin/login');
    assert.equal((await agent.get('/staff/security')).headers.location, '/admin/login');
    assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action = 'login'").get().n, 0);
    f.advance();
    const _csrf = await csrfToken(agent, '/admin/login/verify');
    assert.equal((await post(agent, '/admin/login/verify', { code: totpAt(secret, f.now()) })).status, 403);
    const verified = await post(agent, '/admin/login/verify', { _csrf, code: totpAt(secret, f.now()) });
    assert.equal(verified.headers.location, role === 'instructor' ? '/instructor/schedule' : '/admin');
    assert.equal((await agent.get('/admin')).status, role === 'instructor' ? 403 : 200);
    assert.equal((await agent.get('/staff/security')).status, 200);
    assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action = 'login'").get().n, 1);
  });
}

test('web enrollment protects changes, revokes old cookies and never persists displayed recovery codes', async () => {
  const f = fixture('instructor');
  const agent = request.agent(f.app);
  const oldAgent = request.agent(f.app);
  await login(agent);
  const oldLogin = await login(oldAgent);
  const oldCookie = oldLogin.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');
  const _csrf = await csrfToken(agent, '/staff/security');
  assert.equal((await post(agent, '/staff/security/setup', { _csrf, password: 'wrong' })).status, 400);
  assert.equal((await post(agent, '/staff/security/setup', { password })).status, 403);
  assert.equal((await post(agent, '/staff/security/setup', { _csrf, password })).status, 302);
  const page = await agent.get('/staff/security');
  const secret = page.text.match(/Setup key: <code>([A-Z2-7]+)<\/code>/)[1];
  assert.equal(page.headers['cache-control'], 'no-store');
  const enabled = await post(agent, '/staff/security/enable', { _csrf, password, code: totpAt(secret, f.now()) });
  assert.equal(enabled.status, 200);
  const codes = [...enabled.text.matchAll(/<code>([a-f0-9]{8}(?:-[a-f0-9]{8}){3})<\/code>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10);
  assert.equal(enabled.headers['cache-control'], 'no-store');
  assert.equal((await oldAgent.get('/staff/security')).headers.location, '/admin/login');
  assert.equal((await request(f.app).get('/staff/security').set('Cookie', oldCookie)).headers.location, '/admin/login');
  const cookies = (enabled.headers['set-cookie'] || []).join(' ');
  const payload = JSON.stringify(JSON.parse(Buffer.from(cookies.match(/studio_session=([^;]+)/)[1], 'base64').toString()));
  assert.ok(!payload.includes(secret));
  assert.ok(!payload.includes(codes[0]));
  assert.ok(!payload.includes(env.TOTP_ENCRYPTION_KEY));
  const refreshed = await agent.get('/staff/security');
  assert.ok(!refreshed.text.includes(codes[0]));
  assert.equal((await post(agent, '/staff/security/disable', { _csrf, password: 'wrong', code: codes[0] })).status, 400);
  const disabled = await post(agent, '/staff/security/disable', { _csrf, password, code: codes[0] });
  assert.equal(disabled.status, 302);
  assert.equal(f.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(f.id).totp_secret, null);
});

test('security changes and challenge verification share an IP limit; account codes remain unconsumed on CSRF rejection', async () => {
  const f = fixture();
  const { codes } = enroll(f);
  const agent = request.agent(f.app);
  await login(agent);
  const _csrf = await csrfToken(agent, '/admin/login/verify');
  for (let i = 0; i < 10; i++) assert.equal((await post(agent, '/admin/login/verify', { _csrf, code: 'wrong' })).status, 401);
  assert.equal((await post(agent, '/staff/security/setup', { _csrf, password })).status, 429);
  assert.equal(f.db.prepare('SELECT count(*) n FROM staff_recovery_codes').get().n, codes.length);
});

test('without a key, existing password logins work but enrollment is unavailable; key is not a template local', async () => {
  const f = fixture();
  const app = createApp({ db: f.db, env: {}, now: f.now });
  const agent = request.agent(app);
  assert.equal((await login(agent)).headers.location, '/admin');
  assert.match((await agent.get('/staff/security')).text, /operator must configure/);
  const _csrf = await csrfToken(agent, '/staff/security');
  assert.equal((await post(agent, '/staff/security/setup', { _csrf, password })).status, 400);
  f.app.engine('ejs', (file, options, cb) => cb(null, JSON.stringify(options)));
  assert.ok(!(await request(f.app).get('/admin/login')).text.includes(env.TOTP_ENCRYPTION_KEY));
});

test('logout cancels pending challenge; completed sessions expire server-side', async () => {
  const f = fixture();
  const { codes } = enroll(f);
  const agent = request.agent(f.app);
  await login(agent);
  const _csrf = await csrfToken(agent, '/admin/login/verify');
  await post(agent, '/admin/logout', { _csrf });
  assert.equal(f.db.prepare('SELECT count(*) n FROM staff_login_challenges').get().n, 0);
  await login(agent);
  const csrf = await csrfToken(agent, '/admin/login/verify');
  await post(agent, '/admin/login/verify', { _csrf: csrf, code: codes[0] });
  f.advance(30 * 24 * 3600000);
  assert.equal((await agent.get('/staff/security')).headers.location, '/admin/login');
});

test('an interrupted security change rolls back factor consumption', () => {
  const f = fixture();
  const { codes } = enroll(f);
  assert.throws(() => f.totp.change(f.id, codes[0], 'invalid', 1), /Unknown/);
  assert.ok(f.totp.completeChallenge(f.totp.createChallenge(f.id), codes[0]));
});

test('restarting enrollment invalidates the previous setup nonce without activating 2FA', () => {
  const f = fixture();
  const first = f.totp.startEnrollment(f.id, 0);
  const secret = f.totp.enrollmentSecret(f.id, first);
  const next = f.totp.startEnrollment(f.id, 0);
  assert.equal(f.totp.enrollmentSecret(f.id, first), null);
  assert.equal(f.totp.enable(f.id, first, totpAt(secret, f.now())), null);
  assert.ok(f.totp.enrollmentSecret(f.id, next));
  assert.equal(f.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(f.id).totp_secret, null);
});

test('TOTP migration preserves existing accounts, roles and foreign keys', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const file of ['schema.sql', '002-instructor-role.sql', '003-stripe-invoices.sql', '004-payment-booking.sql']) {
      db.exec(fs.readFileSync(new URL(`../src/db/${file}`, import.meta.url), 'utf8'));
    }
    for (const role of ['owner', 'staff', 'instructor']) createUser(db, { email: `${role}@test.test`, password, role });
    const before = db.prepare('SELECT id, email, password_hash, role FROM users ORDER BY id').all();
    db.exec(fs.readFileSync(new URL('../src/db/005-staff-totp.sql', import.meta.url), 'utf8'));
    assert.deepEqual(db.prepare('SELECT id, email, password_hash, role FROM users ORDER BY id').all(), before);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.prepare('SELECT count(*) n FROM users WHERE auth_version = 0 AND totp_secret IS NULL').get().n, 3);
  } finally { db.close(); }
});
