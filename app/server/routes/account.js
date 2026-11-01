// Sign-in, profile, 2FA, users, teams, API tokens.
import crypto from 'node:crypto';
import os from 'node:os';
import { Router } from 'express';
import QRCode from 'qrcode';
import { all, get, run, id, now, getSettings } from '../db.js';
import {
  HttpError, requireAuth, requireArea, hashPassword, verifyPassword, validatePassword, sha256,
  createSession, destroySession, publicUser, countUsers, createUser, newTotpSecret, verifyTotp,
  throttleCheck, throttleFail, throttleClear, can,
} from '../auth.js';
import { audit } from '../events.js';
import { config } from '../config.js';

export const account = Router();

const ROLES = ['owner', 'admin', 'content', 'device'];

// The desktop app listens on the local network for screens and phones, so another device
// must not be able to claim a new install. The Host check also stops DNS rebinding.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const setupAllowed = (req) => !config.localSetup
  || (LOOPBACK.has(req.socket.remoteAddress) && LOCAL_HOST.test(req.headers.host || ''));

// On the desktop app the studio is opened at localhost, which means nothing to another device.
// Windows often lists virtual adapters first, and their addresses can't be reached from a phone or TV.
const VIRTUAL_ADAPTER = /vEthernet|Hyper-V|WSL|VirtualBox|VMware|Docker|Tailscale|ZeroTier|VPN|Bluetooth/i;
const networkOrigin = () => {
  const found = Object.entries(os.networkInterfaces())
    .flatMap(([adapter, list]) => list.map((n) => ({ ...n, adapter })))
    .filter((n) => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'));
  const ip = (found.find((n) => !VIRTUAL_ADAPTER.test(n.adapter)) || found[0])?.address;
  if (!ip) return null;
  return config.shortAddressActive ? `http://${ip}` : `http://${ip}:${config.port}`;
};

account.get('/auth/state', (req, res) => {
  const s = getSettings();
  res.json({
    needsSetup: countUsers() === 0,
    setupBlocked: countUsers() === 0 && !setupAllowed(req),
    screenOrigin: config.localSetup && setupAllowed(req) ? networkOrigin() : null,
    user: req.user ? publicUser(req.user) : null,
    brand: { name: s.brandName, logo: s.brandLogo, accent: s.accent },
    language: s.language,
  });
});

account.post('/auth/setup', (req, res) => {
  if (countUsers() > 0) throw new HttpError(409, 'Already set up');
  if (!setupAllowed(req)) throw new HttpError(403, 'Create the owner account on the computer running Vitrine');
  const { username, password, name } = req.body || {};
  if (!username?.trim()) throw new HttpError(400, 'Choose a username');
  validatePassword(password);
  const uid = createUser({ username: username.trim(), name, password, role: 'owner' });
  createSession(res, uid);
  req.user = get('SELECT * FROM users WHERE id=?', uid);
  audit(req, 'user.setup', username);
  res.json({ user: publicUser(req.user) });
});

account.post('/auth/login', (req, res) => {
  const { username, password, code } = req.body || {};
  const key = `${req.ip}|${String(username).toLowerCase()}`;
  throttleCheck(key);
  const user = username ? get('SELECT * FROM users WHERE username=? AND active=1', String(username)) : null;
  // Hash even for unknown users so response time doesn't reveal which usernames exist.
  const ok = user ? verifyPassword(String(password), user.password_hash) : (hashPassword('x'), false);
  if (!ok) {
    throttleFail(key);
    throw new HttpError(401, 'Wrong username or password');
  }
  if (user.totp_enabled) {
    if (!code) return res.json({ needsCode: true });
    const counter = verifyTotp(user.totp_secret, code, user.totp_last);
    if (counter === null) {
      throttleFail(key);
      throw new HttpError(401, 'That code is not valid');
    }
    run('UPDATE users SET totp_last=? WHERE id=?', counter, user.id);
  }
  throttleClear(key);
  run('UPDATE users SET last_login=? WHERE id=?', now(), user.id);
  createSession(res, user.id);
  req.user = user;
  audit(req, 'user.login', user.username);
  res.json({ user: publicUser(user) });
});

account.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// ---------- own profile ----------
account.patch('/me', requireAuth, (req, res) => {
  const { name, lang, password, currentPassword } = req.body || {};
  if (password !== undefined) {
    if (!verifyPassword(String(currentPassword), req.user.password_hash)) throw new HttpError(400, 'Current password is wrong');
    validatePassword(password);
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), req.user.id);
    audit(req, 'user.password_changed', req.user.username);
  }
  if (name !== undefined) run('UPDATE users SET name=? WHERE id=?', String(name), req.user.id);
  if (lang !== undefined) run('UPDATE users SET lang=? WHERE id=?', lang || null, req.user.id);
  res.json({ user: publicUser(get('SELECT * FROM users WHERE id=?', req.user.id)) });
});

account.post('/me/totp/start', requireAuth, async (req, res) => {
  const secret = newTotpSecret();
  run('UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?', secret, req.user.id);
  const issuer = encodeURIComponent(getSettings().brandName || 'Vitrine');
  const uri = `otpauth://totp/${issuer}:${encodeURIComponent(req.user.username)}?secret=${secret}&issuer=${issuer}`;
  res.json({ secret, uri, qr: await QRCode.toString(uri, { type: 'svg', margin: 1 }) });
});
account.post('/me/totp/confirm', requireAuth, (req, res) => {
  const u = get('SELECT * FROM users WHERE id=?', req.user.id);
  if (!u.totp_secret) throw new HttpError(400, 'Start two-factor setup first');
  const counter = verifyTotp(u.totp_secret, req.body?.code);
  if (counter === null) throw new HttpError(400, 'That code is not valid');
  run('UPDATE users SET totp_enabled=1, totp_last=? WHERE id=?', counter, u.id);
  audit(req, 'user.2fa_enabled', u.username);
  res.json({ ok: true });
});
account.post('/me/totp/disable', requireAuth, (req, res) => {
  if (!verifyPassword(String(req.body?.password), req.user.password_hash)) throw new HttpError(400, 'Current password is wrong');
  run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?', req.user.id);
  audit(req, 'user.2fa_disabled', req.user.username);
  res.json({ ok: true });
});

// ---------- API tokens ----------
account.get('/me/tokens', requireAuth, (req, res) => {
  res.json(all('SELECT id,name,prefix,created_at AS createdAt,last_used AS lastUsed FROM api_tokens WHERE user_id=? ORDER BY created_at DESC', req.user.id));
});
account.post('/me/tokens', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim() || 'Token';
  const token = `vt_${crypto.randomBytes(30).toString('base64url')}`;
  const tid = id();
  run('INSERT INTO api_tokens(id,user_id,name,token_hash,prefix,created_at) VALUES(?,?,?,?,?,?)', tid, req.user.id, name, sha256(token), token.slice(0, 9), now());
  audit(req, 'token.created', name);
  res.status(201).json({ id: tid, name, token });
});
account.delete('/me/tokens/:id', requireAuth, (req, res) => {
  run('DELETE FROM api_tokens WHERE id=? AND user_id=?', req.params.id, req.user.id);
  audit(req, 'token.revoked', req.params.id);
  res.json({ ok: true });
});

// ---------- users & teams ----------
const security = requireArea('security');

function guardRoleChange(actor, targetRole, target) {
  if (!ROLES.includes(targetRole)) throw new HttpError(400, 'Unknown role');
  // Only the owner can create or modify owners and admins' owner status.
  if ((targetRole === 'owner' || target?.role === 'owner') && !can(actor, 'owner')) throw new HttpError(403, 'Only the owner can do this');
  if (targetRole === 'owner' && target?.role !== 'owner') throw new HttpError(400, 'There is only one owner per instance');
}

account.get('/users', security, (_req, res) => res.json(all('SELECT * FROM users ORDER BY username').map(publicUser)));
account.post('/users', security, (req, res) => {
  const { username, name, password, role = 'content', teamId } = req.body || {};
  if (!username?.trim()) throw new HttpError(400, 'Choose a username');
  validatePassword(password);
  guardRoleChange(req.user, role);
  if (get('SELECT 1 FROM users WHERE username=?', username.trim())) throw new HttpError(409, 'That username is taken');
  const uid = createUser({ username: username.trim(), name, password, role, teamId });
  audit(req, 'user.created', username);
  res.status(201).json(publicUser(get('SELECT * FROM users WHERE id=?', uid)));
});
account.patch('/users/:id', security, (req, res) => {
  const u = get('SELECT * FROM users WHERE id=?', req.params.id);
  if (!u) throw new HttpError(404, 'Not found');
  const { name, role, teamId, active, password } = req.body || {};
  if (u.role === 'owner' && !can(req.user, 'owner')) throw new HttpError(403, 'Only the owner can do this');
  if (role !== undefined && role !== u.role) {
    guardRoleChange(req.user, role, u);
    if (u.role === 'owner') throw new HttpError(400, 'The owner role cannot be removed');
    run('UPDATE users SET role=? WHERE id=?', role, u.id);
  }
  if (name !== undefined) run('UPDATE users SET name=? WHERE id=?', String(name), u.id);
  if (teamId !== undefined) run('UPDATE users SET team_id=? WHERE id=?', teamId || null, u.id);
  if (active !== undefined) {
    if (u.role === 'owner') throw new HttpError(400, 'The owner cannot be deactivated');
    run('UPDATE users SET active=? WHERE id=?', active ? 1 : 0, u.id);
    if (!active) run('DELETE FROM sessions WHERE user_id=?', u.id);
  }
  if (password) {
    validatePassword(password);
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), u.id);
    run('DELETE FROM sessions WHERE user_id=?', u.id);
  }
  audit(req, 'user.updated', u.username);
  res.json(publicUser(get('SELECT * FROM users WHERE id=?', u.id)));
});
account.delete('/users/:id', security, (req, res) => {
  const u = get('SELECT * FROM users WHERE id=?', req.params.id);
  if (!u) throw new HttpError(404, 'Not found');
  if (u.role === 'owner') throw new HttpError(400, 'The owner cannot be deleted');
  if (u.id === req.user.id) throw new HttpError(400, 'You cannot delete your own account');
  run('DELETE FROM users WHERE id=?', u.id);
  audit(req, 'user.deleted', u.username);
  res.json({ ok: true });
});

account.get('/teams', requireAuth, (_req, res) => {
  res.json(all(`SELECT t.id, t.name, (SELECT COUNT(*) FROM users u WHERE u.team_id=t.id) AS members FROM teams t ORDER BY t.name`));
});
account.post('/teams', security, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new HttpError(400, 'Name the team');
  if (get('SELECT 1 FROM teams WHERE name=?', name)) throw new HttpError(409, 'That team already exists');
  const tid = id();
  run('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)', tid, name, now());
  audit(req, 'team.created', name);
  res.status(201).json({ id: tid, name, members: 0 });
});
account.delete('/teams/:id', security, (req, res) => {
  const team = get('SELECT name FROM teams WHERE id=?', req.params.id);
  if (!team) throw new HttpError(404, 'Not found');
  run('DELETE FROM teams WHERE id=?', req.params.id);
  audit(req, 'team.deleted', team.name);
  res.json({ ok: true });
});
