import crypto from 'node:crypto';
import { audit } from '../db/index.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TTL = 10 * 60 * 1000;
const FAILURE_WINDOW = 15 * 60 * 1000;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nonce = () => crypto.randomBytes(32).toString('hex');

export function generateSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += ALPHABET[(value >>> bits) & 31];
    }
  }
  return result;
}

/** RFC 6238: SHA-1, six digits, 30-second period (authenticator defaults). */
export function totpAt(secret, now) {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error('Invalid authenticator secret');
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const mac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[19] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function matchingStep(secret, code, now, last = -1) {
  if (!secret || typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  let match = null;
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, step * 30000)), Buffer.from(code)) && step > last) match = step;
  }
  return match;
}

const recoveryHash = (id, code) => digest(`${id}:${code}`);
function normalizeRecovery(code) {
  if (typeof code !== 'string' || code.length > 40) return null;
  const normalized = code.replaceAll('-', '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null;
}

export function createTotpService({ db, env, now }) {
  const configured = typeof env.TOTP_ENCRYPTION_KEY === 'string' && /^[a-fA-F0-9]{64}$/.test(env.TOTP_ENCRYPTION_KEY);
  if (env.TOTP_ENCRYPTION_KEY && !configured) throw new Error('TOTP_ENCRYPTION_KEY must be 64 hexadecimal characters');
  if (!configured && db.prepare('SELECT 1 FROM users WHERE totp_secret IS NOT NULL').get()) {
    throw new Error('TOTP_ENCRYPTION_KEY is required for enrolled staff accounts');
  }
  const key = configured ? Buffer.from(env.TOTP_ENCRYPTION_KEY, 'hex') : null;
  const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const encrypt = (id, secret) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`studio-os:totp:${id}`));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  };
  const decrypt = (id, encrypted) => {
    try {
      const bytes = Buffer.from(encrypted, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`studio-os:totp:${id}`));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      // A changed key or damaged ciphertext must not block the recovery UI.
      return null;
    }
  };
  function allowed(account) {
    return account.totp_window_end <= now() || account.totp_failures < 5;
  }
  function failed(account) {
    const expired = account.totp_window_end <= now();
    db.prepare('UPDATE users SET totp_failures = ?, totp_window_end = ? WHERE id = ?')
      .run(expired ? 1 : account.totp_failures + 1, expired ? now() + FAILURE_WINDOW : account.totp_window_end, account.id);
  }
  function resetFailures(id) {
    db.prepare('UPDATE users SET totp_failures = 0, totp_window_end = 0 WHERE id = ?').run(id);
  }
  function newRecoveryCodes(id) {
    const codes = Array.from({ length: 10 }, () => crypto.randomBytes(16).toString('hex'));
    db.prepare('DELETE FROM staff_recovery_codes WHERE user_id = ?').run(id);
    const insert = db.prepare('INSERT INTO staff_recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const code of codes) insert.run(id, recoveryHash(id, code));
    return codes.map((code) => code.match(/.{8}/g).join('-'));
  }
  // Called only inside the surrounding immediate transaction: code consumption
  // and its login/settings change commit together, even across app processes.
  function consumeFactor(account, code) {
    if (!account.totp_secret || !allowed(account)) return false;
    const step = matchingStep(decrypt(account.id, account.totp_secret), code, now(), account.totp_last_step);
    if (step !== null) {
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, account.id);
    } else {
      const normalized = normalizeRecovery(code);
      if (!normalized || !db.prepare('DELETE FROM staff_recovery_codes WHERE user_id = ? AND code_hash = ?')
        .run(account.id, recoveryHash(account.id, normalized)).changes) {
        failed(account);
        return false;
      }
    }
    resetFailures(account.id);
    return true;
  }
  function revoke(id) {
    db.prepare('UPDATE users SET auth_version = auth_version + 1 WHERE id = ?').run(id);
    db.prepare('DELETE FROM staff_login_challenges WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM staff_totp_enrollments WHERE user_id = ?').run(id);
  }
  function enrollment(id, token) {
    if (typeof token !== 'string') return null;
    return db.prepare(`SELECT e.* FROM staff_totp_enrollments e JOIN users u ON u.id = e.user_id
      WHERE e.user_id = ? AND e.token_hash = ? AND e.expires_at > ? AND e.auth_version = u.auth_version AND u.totp_secret IS NULL`)
      .get(id, digest(token), now());
  }
  return {
    configured,
    signOutAll(id, version) {
      return db.transaction(() => {
        const account = user(id);
        if (!account || account.auth_version !== version) return false;
        revoke(id);
        audit(db, account.email, 'logout_all', `user:${id}`);
        return true;
      }).immediate();
    },
    startEnrollment(id, version) {
      if (!configured) throw new Error('Authenticator enrollment is not configured');
      return db.transaction(() => {
        const account = user(id);
        if (account.auth_version !== version || account.totp_secret || !allowed(account)) return null;
        const token = nonce();
        db.prepare(`INSERT INTO staff_totp_enrollments (user_id, token_hash, secret, auth_version, expires_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash,
          secret = excluded.secret, auth_version = excluded.auth_version, expires_at = excluded.expires_at`)
          .run(id, digest(token), encrypt(id, generateSecret()), account.auth_version, now() + TTL);
        return token;
      }).immediate();
    },
    enrollmentSecret(id, token) {
      const pending = enrollment(id, token);
      return pending ? decrypt(id, pending.secret) : null;
    },
    cancelEnrollment(id, token) {
      if (typeof token !== 'string') return false;
      return Boolean(db.prepare('DELETE FROM staff_totp_enrollments WHERE user_id = ? AND token_hash = ?')
        .run(id, digest(token)).changes);
    },
    enable(id, token, code) {
      return db.transaction(() => {
        const account = user(id);
        const pending = enrollment(id, token);
        if (!pending || !allowed(account)) return null;
        const step = matchingStep(decrypt(id, pending.secret), code, now());
        if (step === null) { failed(account); return null; }
        db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?').run(pending.secret, step, id);
        resetFailures(id);
        revoke(id);
        const codes = newRecoveryCodes(id);
        audit(db, account.email, 'totp_enabled', `user:${id}`);
        return { user: user(id), codes };
      }).immediate();
    },
    createChallenge(id) {
      return db.transaction(() => {
        const account = user(id);
        if (!account.totp_secret || !allowed(account)) return null;
        db.prepare('DELETE FROM staff_login_challenges WHERE expires_at <= ? OR user_id = ?').run(now(), id);
        const token = nonce();
        db.prepare('INSERT INTO staff_login_challenges (token_hash, user_id, auth_version, expires_at) VALUES (?, ?, ?, ?)')
          .run(digest(token), id, account.auth_version, now() + TTL);
        return token;
      }).immediate();
    },
    cancelChallenge(token) {
      if (typeof token === 'string') db.prepare('DELETE FROM staff_login_challenges WHERE token_hash = ?').run(digest(token));
    },
    completeChallenge(token, code) {
      if (typeof token !== 'string') return null;
      return db.transaction(() => {
        const challenge = db.prepare('SELECT * FROM staff_login_challenges WHERE token_hash = ? AND expires_at > ?').get(digest(token), now());
        if (!challenge) return null;
        const account = user(challenge.user_id);
        if (!account || challenge.auth_version !== account.auth_version || !consumeFactor(account, code)) return null;
        db.prepare('DELETE FROM staff_login_challenges WHERE user_id = ?').run(account.id);
        audit(db, account.email, 'login', `user:${account.id}`);
        return user(account.id);
      }).immediate();
    },
    change(id, code, action, version) {
      return db.transaction(() => {
        const account = user(id);
        if (account.auth_version !== version || !consumeFactor(account, code)) return null;
        let codes = null;
        if (action === 'disable') {
          db.prepare('UPDATE users SET totp_secret = NULL, totp_last_step = -1 WHERE id = ?').run(id);
          db.prepare('DELETE FROM staff_recovery_codes WHERE user_id = ?').run(id);
        } else if (action === 'regenerate') codes = newRecoveryCodes(id);
        else throw new Error('Unknown authenticator action');
        revoke(id);
        audit(db, account.email, action === 'disable' ? 'totp_disabled' : 'totp_recovery_regenerated', `user:${id}`);
        return { user: user(id), codes };
      }).immediate();
    },
  };
}
