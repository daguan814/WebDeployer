import crypto from 'node:crypto';
import {
  db,
  getSetting,
  setSetting,
} from './store.js';
import {
  COOKIE_NAME,
  FAILURE_DECAY_MS,
  LOCK_STEPS_MS,
  LOCK_THRESHOLD,
  SESSION_TTL_MS,
  TLS_ENABLED,
  TRUST_PROXY,
} from './config.js';

const LOCAL_IPS = new Set(['127.0.0.1', '::1']);

export function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  let ip = req.socket?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip || 'unknown';
}

// 本机访问不参与锁定，避免把自己锁在门外
function isExempt(ip) {
  return LOCAL_IPS.has(ip) || ip === 'unknown';
}

/* ---------------------------------- 密码 ---------------------------------- */

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, key] = parts;
  const expected = Buffer.from(key, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length || 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function hasPassword() {
  return Boolean(getSetting('password_hash'));
}

export function setPassword(password) {
  if (!password || String(password).length < 6) {
    throw new Error('密码至少 6 位');
  }
  setSetting('password_hash', hashPassword(password));
  clearAllFailures();
  deleteAllSessions();
}

export function checkPassword(password) {
  const stored = getSetting('password_hash');
  if (!stored) return false;
  return verifyPassword(password, stored);
}

/* --------------------------------- 失败锁定 -------------------------------- */

function readEvent(ip) {
  return (
    db.prepare('SELECT * FROM login_events WHERE ip = ?').get(ip) || {
      ip,
      strikes: 0,
      locked_until: 0,
      last_fail: 0,
      updated_at: 0,
    }
  );
}

function writeEvent(ip, strikes, lockedUntil, lastFail) {
  db.prepare(
    `INSERT INTO login_events (ip, strikes, locked_until, last_fail, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET
       strikes = excluded.strikes,
       locked_until = excluded.locked_until,
       last_fail = excluded.last_fail,
       updated_at = excluded.updated_at`,
  ).run(ip, strikes, lockedUntil, lastFail, Date.now());
}

export function lockState(ip) {
  if (isExempt(ip)) return { locked: false, retryAfterMs: 0, strikes: 0, remaining: Infinity };
  const ev = readEvent(ip);
  const now = Date.now();
  // 长时间没再失败，清零
  if (ev.strikes > 0 && now - ev.last_fail > FAILURE_DECAY_MS && now >= ev.locked_until) {
    writeEvent(ip, 0, 0, 0);
    return { locked: false, retryAfterMs: 0, strikes: 0, remaining: LOCK_THRESHOLD };
  }
  const locked = now < ev.locked_until;
  return {
    locked,
    retryAfterMs: locked ? ev.locked_until - now : 0,
    strikes: ev.strikes,
    remaining: Math.max(0, LOCK_THRESHOLD - ev.strikes),
  };
}

export function recordFailure(ip) {
  if (isExempt(ip)) return lockState(ip);
  const ev = readEvent(ip);
  const now = Date.now();
  const stale = now - ev.last_fail > FAILURE_DECAY_MS;
  const strikes = (stale ? 0 : ev.strikes) + 1;
  let lockedUntil = 0;
  if (strikes >= LOCK_THRESHOLD) {
    const step = Math.min(strikes - LOCK_THRESHOLD, LOCK_STEPS_MS.length - 1);
    lockedUntil = now + LOCK_STEPS_MS[step];
  }
  writeEvent(ip, strikes, lockedUntil, now);
  return lockState(ip);
}

export function clearFailures(ip) {
  if (isExempt(ip)) return;
  writeEvent(ip, 0, 0, 0);
}

export function clearAllFailures() {
  db.prepare('DELETE FROM login_events').run();
}

export function listLockedIps() {
  return db
    .prepare('SELECT * FROM login_events WHERE strikes > 0 ORDER BY updated_at DESC')
    .all();
}

/* ---------------------------------- 会话 ---------------------------------- */

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function createSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token, ip, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)',
  ).run(sha256(token), ip, now, now + SESSION_TTL_MS, now);
  return token;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(sha256(token));
}

export function destroyAllSessions() {
  deleteAllSessions();
}

function deleteAllSessions() {
  db.prepare('DELETE FROM sessions').run();
}

export function readCookie(req, name = COOKIE_NAME) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function currentSession(req) {
  const token = readCookie(req);
  if (!token) return null;
  const now = Date.now();
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(sha256(token));
  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(row.token);
    return null;
  }
  // 滑动续期：活跃就延长
  if (now - row.last_seen > 5 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token = ?').run(
      now,
      now + SESSION_TTL_MS,
      row.token,
    );
  }
  return row;
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

export function isSecureRequest(req) {
  // 服务自己就是 https，Cookie 直接带 Secure
  if (TLS_ENABLED) return true;
  if (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').includes('https')) return true;
  return false;
}

export function buildSessionCookie(token, req) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

export function buildLogoutCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 简单有效的 CSRF 防护：写操作必须来自同源 */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端（curl 等）不带 Origin
  try {
    const host = req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
