import crypto from 'node:crypto';
import { all, get, run, id, now } from './db.js';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- passwords ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length), expected);
}
export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
}
export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// ---------- TOTP (RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  let out = '';
  for (const b of crypto.randomBytes(20)) out += B32[b & 31];
  return out;
}
function b32decode(s) {
  let bits = 0, value = 0;
  const bytes = [];
  for (const c of s) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
export function totpCode(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const off = mac[19] & 15;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1e6).padStart(6, '0');
}
/** Returns the matched counter, rejecting codes at or before `last` so a code cannot be replayed. */
export function verifyTotp(secret, code, last = 0) {
  const t = Math.floor(Date.now() / 30000);
  for (const c of [t, t - 1, t + 1]) {
    if (c > last && totpCode(secret, c) === String(code).trim()) return c;
  }
  return null;
}

// ---------- sessions ----------
export const COOKIE = 'vt_session';
export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 864e5);
  run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha256(token), userId, expires.toISOString());
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.https, expires, path: '/' });
}
export function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
export function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) run('DELETE FROM sessions WHERE token_hash=?', sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}
export const purgeSessions = () => run('DELETE FROM sessions WHERE expires_at < ?', now());

// ---------- request identity ----------
export function authenticate(req, _res, next) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  if (bearer) {
    const row = get(`SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND u.active=1`, sha256(bearer));
    if (row) {
      req.user = row;
      req.viaToken = true;
      run('UPDATE api_tokens SET last_used=? WHERE id=?', now(), row.token_id);
    }
    return next();
  }
  const cookie = readCookie(req, COOKIE);
  if (cookie) {
    const row = get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, sha256(cookie), now());
    if (row) req.user = row;
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) throw new HttpError(401, 'Sign in required');
  next();
}

// Permission areas per role. Owner and admin have everything.
const AREAS = {
  owner: ['content', 'device', 'security', 'owner'],
  admin: ['content', 'device', 'security'],
  content: ['content'],
  device: ['device'],
};
export const can = (user, area) => Boolean(user && AREAS[user.role]?.includes(area));
export const requireArea = (...areas) => (req, _res, next) => {
  if (!req.user) throw new HttpError(401, 'Sign in required');
  if (!areas.some((a) => can(req.user, a))) throw new HttpError(403, 'You do not have permission to do this');
  next();
};

// ---------- team scoping ----------
// A user in a team sees their team's items plus unassigned ones. Owners and team-less users see all.
const seesAll = (u) => u.role === 'owner' || !u.team_id;
export const canTouch = (u, row) => seesAll(u) || !row.team_id || row.team_id === u.team_id;
export const scoped = (u, rows) => (seesAll(u) ? rows : rows.filter((r) => canTouch(u, r)));
export function loadScoped(req, table, rowId) {
  const row = get(`SELECT * FROM ${table} WHERE id=?`, rowId);
  if (!row || !canTouch(req.user, row)) throw new HttpError(404, 'Not found');
  return row;
}
/** Team for a newly created row: only owner/admin may choose another team. */
export function teamFor(user, requested) {
  if (requested !== undefined && (user.role === 'owner' || user.role === 'admin')) return requested || null;
  return user.team_id || null;
}

// ---------- brute-force throttle ----------
const attempts = new Map();
const WINDOW = 15 * 60e3, MAX = 10;
export function throttleCheck(key) {
  const a = attempts.get(key);
  if (a && a.count >= MAX && Date.now() - a.first < WINDOW) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}
export function throttleFail(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}
export const throttleClear = (key) => attempts.delete(key);

export function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, teamId: u.team_id, lang: u.lang,
    totpEnabled: Boolean(u.totp_enabled), active: Boolean(u.active), lastLogin: u.last_login, createdAt: u.created_at,
  };
}

export const countUsers = () => get('SELECT COUNT(*) AS c FROM users').c;
export function createUser({ username, name, password, role, teamId }) {
  const uid = id();
  run('INSERT INTO users(id,username,name,password_hash,role,team_id,created_at) VALUES(?,?,?,?,?,?,?)',
    uid, username, name || username, hashPassword(password), role, teamId || null, now());
  return uid;
}
export const listOwners = () => all("SELECT * FROM users WHERE role='owner'");
