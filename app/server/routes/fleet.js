// Screens, groups, dayparting rules, broadcasts, and the player-facing endpoints.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { all, get, run, id, now, parse, tx, getSettings } from '../db.js';
import { HttpError, requireArea, requireAuth, loadScoped, scoped, teamFor, sha256 } from '../auth.js';
import { audit, emit, addPlayerStream, sendToScreen, refreshPlayers, notifyAdmins } from '../events.js';
import { buildManifest } from '../manifest.js';

export const fleet = Router();
export const playerApi = Router();
const deviceArea = requireArea('device');
const OFFLINE_AFTER_MS = 90e3;

// What each screen last reported it couldn't show. Only useful while it's happening, so it isn't stored.
const playerErrors = new Map();

function screenOut(s) {
  const group = s.group_id ? get('SELECT id,name,playlist_id FROM screen_groups WHERE id=?', s.group_id) : null;
  const effective = s.playlist_id || group?.playlist_id || null;
  const pl = effective ? get('SELECT id,name FROM playlists WHERE id=?', effective) : null;
  return {
    id: s.id, name: s.name, location: s.location, groupId: s.group_id, groupName: group?.name ?? null, playlistId: s.playlist_id,
    effectivePlaylist: pl, teamId: s.team_id, settings: parse(s.settings, {}), online: Boolean(s.online), lastSeen: s.last_seen,
    ip: s.ip, userAgent: s.user_agent, resolution: s.resolution, nowPlaying: s.now_playing, nowPlayingId: s.now_playing_id,
    nowPlayingThumb: s.now_playing_id ? thumbOf(s.now_playing_id) : null, offlineReady: Boolean(s.offline_ready), createdAt: s.created_at,
    ruleCount: get("SELECT COUNT(*) AS n FROM rules WHERE target_type='screen' AND target_id=?", s.id).n,
    playerError: playerErrors.get(s.id) || null,
  };
}
function thumbOf(contentId) {
  const c = get('SELECT thumb,file,type FROM content WHERE id=?', contentId);
  if (!c) return null;
  return c.thumb ? `/media/${c.thumb}` : c.type === 'image' && c.file ? `/media/${c.file}` : null;
}

// ---------- screens ----------
fleet.get('/screens', requireAuth, (req, res) => res.json(scoped(req.user, all('SELECT * FROM screens ORDER BY name')).map(screenOut)));

// A readable default name, so a screen connected without typing is still recognisable in the list.
const DEVICE_NAMES = [
  [/Tizen|SAMSUNG.*TV/i, 'Samsung TV'], [/Web0S|webOS/i, 'LG TV'], [/BRAVIA/i, 'Sony TV'], [/\bAFT[A-Z]/, 'Fire TV'],
  [/Android TV|GoogleTV|CrKey/i, 'Android TV'], [/SMART-?TV|HbbTV|\bTV\b/i, 'TV'],
  [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android.*Mobile/, 'Android phone'], [/Android/, 'Android tablet'],
  [/Windows/, 'Windows PC'], [/Macintosh/, 'Mac'], [/CrOS/, 'Chromebook'], [/Linux/, 'Linux computer'],
];
const deviceName = (userAgent) => DEVICE_NAMES.find(([re]) => re.test(userAgent || ''))?.[1] || 'Screen';

function uniqueName(base) {
  let name = base;
  for (let n = 2; get('SELECT 1 AS x FROM screens WHERE name=?', name); n++) name = `${base} ${n}`;
  return name;
}

function addScreen(hash, name, { location, groupId, playlistId, teamId }) {
  const sid = id();
  tx(() => {
    run('INSERT INTO screens(id,name,location,device_key_hash,group_id,playlist_id,team_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
      sid, name, location || '', hash, groupId || null, playlistId || null, teamId || null, now());
    run('DELETE FROM pairings WHERE device_key_hash=?', hash);
  });
  return sid;
}

// Devices showing a pairing code, by code. Each one polls, so this only needs to outlive a poll or two.
const waitingDevices = new Map();
const WAITING_FOR_MS = 10e3;
const PRIVATE_ADDRESS = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80:)/i;
const plainIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

// QR codes connect a device without a code. They're held in memory because they only last minutes.
const invites = new Map();
const INVITE_MS = 10 * 60e3;

fleet.post('/screens/invites', deviceArea, async (req, res) => {
  const origin = String(req.body?.origin || '');
  if (!/^https?:\/\/[^/?#\s]+$/.test(origin)) throw new HttpError(400, 'Invalid address');
  for (const [hash, invite] of invites) if (invite.expires < Date.now()) invites.delete(hash);
  const token = crypto.randomBytes(16).toString('base64url');
  const expires = Date.now() + INVITE_MS;
  invites.set(sha256(token), { expires, teamId: teamFor(req.user) });
  const url = `${origin}/tv?invite=${token}`;
  res.status(201).json({ url, expiresAt: new Date(expires).toISOString(), qr: await QRCode.toString(url, { type: 'svg', margin: 2 }) });
});

// Only on the desktop app: on a server reachable from the internet, anyone could put a device in this list.
fleet.get('/screens/waiting', deviceArea, (_req, res) => {
  if (!config.localSetup) return res.json({ supported: false, waiting: [] });
  const live = new Set(all('SELECT code FROM pairings WHERE expires_at>?', now()).map((p) => p.code));
  const waiting = [];
  for (const [code, d] of waitingDevices) {
    if (!live.has(code) || Date.now() - d.seen > WAITING_FOR_MS) waitingDevices.delete(code);
    else waiting.push({ code, device: d.device, ip: d.ip });
  }
  res.json({ supported: true, waiting });
});

fleet.post('/screens/pair', deviceArea, (req, res) => {
  const code = String(req.body?.code || '').replace(/[\s-]/g, '').toUpperCase();
  const pairing = get('SELECT * FROM pairings WHERE code=? AND expires_at>?', code, now());
  if (!pairing) throw new HttpError(404, 'That code was not found. Check the screen, as codes change every 15 minutes.');
  const device = waitingDevices.get(code)?.device;
  const name = String(req.body?.name || '').trim() || (device ? uniqueName(device) : `Screen ${get('SELECT COUNT(*) AS n FROM screens').n + 1}`);
  const sid = addScreen(pairing.device_key_hash, name, { ...req.body, teamId: teamFor(req.user) });
  waitingDevices.delete(code);
  audit(req, 'screen.paired', name);
  res.status(201).json(screenOut(get('SELECT * FROM screens WHERE id=?', sid)));
});

fleet.patch('/screens/:id', deviceArea, (req, res) => {
  const s = loadScoped(req, 'screens', req.params.id);
  const { name, location, groupId, playlistId, settings, teamId } = req.body || {};
  if (name !== undefined) run('UPDATE screens SET name=? WHERE id=?', String(name).trim() || s.name, s.id);
  if (location !== undefined) run('UPDATE screens SET location=? WHERE id=?', String(location), s.id);
  if (groupId !== undefined) run('UPDATE screens SET group_id=? WHERE id=?', groupId || null, s.id);
  if (playlistId !== undefined) run('UPDATE screens SET playlist_id=? WHERE id=?', playlistId || null, s.id);
  if (settings !== undefined) run('UPDATE screens SET settings=? WHERE id=?', JSON.stringify(settings), s.id);
  if (teamId !== undefined && ['owner', 'admin'].includes(req.user.role)) run('UPDATE screens SET team_id=? WHERE id=?', teamId || null, s.id);
  audit(req, 'screen.updated', s.name);
  refreshPlayers();
  res.json(screenOut(get('SELECT * FROM screens WHERE id=?', s.id)));
});

fleet.delete('/screens/:id', deviceArea, (req, res) => {
  const s = loadScoped(req, 'screens', req.params.id);
  sendToScreen(s.id, { type: 'unpaired' });
  tx(() => {
    run("DELETE FROM rules WHERE target_type='screen' AND target_id=?", s.id);
    run('DELETE FROM screens WHERE id=?', s.id);
  });
  audit(req, 'screen.removed', s.name);
  res.json({ ok: true });
});

// ---------- mirroring ----------
// Pictures of someone's screen are relayed live and never written to disk.
const mirrors = new Map();
const MIRROR_IDLE_MS = 15e3;
const mirrorFor = (screenId) => [...mirrors.values()].find((m) => m.screens.has(screenId));

function endMirror(m) {
  mirrors.delete(m.id);
  for (const viewer of m.viewers) viewer.end();
  for (const sid of m.screens) sendToScreen(sid, { type: 'mirror-stop' });
}
// The sender sends continuously, so silence means its tab closed or the computer went to sleep.
setInterval(() => {
  for (const m of mirrors.values()) if (Date.now() - m.lastFrame > MIRROR_IDLE_MS) endMirror(m);
}, 5e3).unref();

fleet.post('/mirror', deviceArea, (req, res) => {
  const ids = Array.isArray(req.body?.screenIds) ? req.body.screenIds.map(String) : [];
  if (!ids.length) throw new HttpError(400, 'Choose at least one screen');
  const rows = ids.map((sid) => loadScoped(req, 'screens', sid));
  for (const s of rows) {
    const earlier = mirrorFor(s.id);
    if (!earlier) continue;
    earlier.screens.delete(s.id);
    if (!earlier.screens.size) endMirror(earlier);
  }
  const m = { id: id(), userId: req.user.id, screens: new Set(ids), viewers: new Set(), frame: null, lastFrame: Date.now() };
  mirrors.set(m.id, m);
  for (const sid of ids) sendToScreen(sid, { type: 'mirror', id: m.id });
  audit(req, 'screen.mirror', rows.map((s) => s.name).join(', '));
  res.status(201).json({ id: m.id });
});

const ownMirror = (req) => {
  const m = mirrors.get(req.params.id);
  if (!m || m.userId !== req.user.id) throw new HttpError(404, 'Mirroring has ended');
  return m;
};

fleet.post('/mirror/:id/frame', deviceArea, express.raw({ type: 'image/jpeg', limit: '8mb' }), (req, res) => {
  const m = ownMirror(req);
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'No picture received');
  m.frame = req.body;
  m.lastFrame = Date.now();
  // A slow screen skips frames rather than falling further and further behind.
  for (const viewer of m.viewers) if (!viewer.writableNeedDrain) writeFrame(viewer, m.frame);
  res.json({ ok: true });
});

fleet.delete('/mirror/:id', deviceArea, (req, res) => {
  endMirror(ownMirror(req));
  res.json({ ok: true });
});

function writeFrame(res, frame) {
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write('\r\n');
}

const COMMANDS = new Set(['reload', 'identify', 'refresh']);
fleet.post('/screens/:id/command', deviceArea, (req, res) => {
  const s = loadScoped(req, 'screens', req.params.id);
  const type = req.body?.command;
  if (!COMMANDS.has(type)) throw new HttpError(400, 'Unknown command');
  const delivered = sendToScreen(s.id, { type, name: s.name });
  audit(req, `screen.${type}`, s.name);
  res.json({ delivered });
});

// ---------- groups ----------
function groupOut(g) {
  const pl = g.playlist_id ? get('SELECT id,name FROM playlists WHERE id=?', g.playlist_id) : null;
  const c = get('SELECT COUNT(*) AS n, COALESCE(SUM(online),0) AS o FROM screens WHERE group_id=?', g.id);
  return {
    id: g.id, name: g.name, playlistId: g.playlist_id, playlist: pl, teamId: g.team_id, screens: c.n, online: c.o,
    ruleCount: get("SELECT COUNT(*) AS n FROM rules WHERE target_type='group' AND target_id=?", g.id).n,
  };
}
fleet.get('/groups', requireAuth, (req, res) => res.json(scoped(req.user, all('SELECT * FROM screen_groups ORDER BY name')).map(groupOut)));
fleet.post('/groups', deviceArea, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new HttpError(400, 'Name the group');
  const gid = id();
  run('INSERT INTO screen_groups(id,name,playlist_id,team_id,created_at) VALUES(?,?,?,?,?)', gid, name, req.body.playlistId || null, teamFor(req.user), now());
  audit(req, 'group.created', name);
  refreshPlayers();
  res.status(201).json(groupOut(get('SELECT * FROM screen_groups WHERE id=?', gid)));
});
fleet.patch('/groups/:id', deviceArea, (req, res) => {
  const g = loadScoped(req, 'screen_groups', req.params.id);
  const { name, playlistId, teamId } = req.body || {};
  if (name !== undefined) run('UPDATE screen_groups SET name=? WHERE id=?', String(name).trim() || g.name, g.id);
  if (playlistId !== undefined) run('UPDATE screen_groups SET playlist_id=? WHERE id=?', playlistId || null, g.id);
  if (teamId !== undefined && ['owner', 'admin'].includes(req.user.role)) run('UPDATE screen_groups SET team_id=? WHERE id=?', teamId || null, g.id);
  audit(req, 'group.updated', g.name);
  refreshPlayers();
  res.json(groupOut(get('SELECT * FROM screen_groups WHERE id=?', g.id)));
});
fleet.delete('/groups/:id', deviceArea, (req, res) => {
  const g = loadScoped(req, 'screen_groups', req.params.id);
  tx(() => {
    run("DELETE FROM rules WHERE target_type='group' AND target_id=?", g.id);
    run('DELETE FROM screen_groups WHERE id=?', g.id);
  });
  audit(req, 'group.deleted', g.name);
  refreshPlayers();
  res.json({ ok: true });
});

// ---------- dayparting ----------
const TIME = /^\d{2}:\d{2}$/;
function loadTarget(req, type, targetId) {
  if (type === 'screen') return loadScoped(req, 'screens', targetId);
  if (type === 'group') return loadScoped(req, 'screen_groups', targetId);
  throw new HttpError(400, 'Rules apply to a screen or group');
}
const ruleOut = (r) => ({
  id: r.id, targetType: r.target_type, targetId: r.target_id, name: r.name, playlistId: r.playlist_id,
  playlistName: r.playlist_id ? get('SELECT name FROM playlists WHERE id=?', r.playlist_id)?.name : null,
  days: parse(r.days, []), from: r.from_time, to: r.to_time, startDate: r.start_date, endDate: r.end_date, priority: r.priority,
});
fleet.get('/rules', requireAuth, (req, res) => {
  loadTarget(req, req.query.targetType, req.query.targetId);
  res.json(all('SELECT * FROM rules WHERE target_type=? AND target_id=? ORDER BY priority DESC, from_time', req.query.targetType, req.query.targetId).map(ruleOut));
});
fleet.post('/rules', deviceArea, (req, res) => {
  const { targetType, targetId, name, playlistId, days, from, to, startDate, endDate, priority } = req.body || {};
  loadTarget(req, targetType, targetId);
  if (!TIME.test(from || '') || !TIME.test(to || '')) throw new HttpError(400, 'Choose a start and end time');
  const rid = id();
  run('INSERT INTO rules(id,target_type,target_id,name,playlist_id,days,from_time,to_time,start_date,end_date,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    rid, targetType, targetId, name || '', playlistId || null, JSON.stringify(days || []), from, to, startDate || null, endDate || null, Number(priority) || 0);
  audit(req, 'rule.created', name || `${from}-${to}`);
  refreshPlayers();
  res.status(201).json(ruleOut(get('SELECT * FROM rules WHERE id=?', rid)));
});
fleet.delete('/rules/:id', deviceArea, (req, res) => {
  const r = get('SELECT * FROM rules WHERE id=?', req.params.id);
  if (!r) throw new HttpError(404, 'Not found');
  loadTarget(req, r.target_type, r.target_id);
  run('DELETE FROM rules WHERE id=?', r.id);
  refreshPlayers();
  res.json({ ok: true });
});

// ---------- broadcasts ----------
const broadcastOut = (b) => ({
  id: b.id, title: b.title, message: b.message, style: b.style, layout: b.layout, targets: parse(b.targets, {}),
  startsAt: b.starts_at, expiresAt: b.expires_at, endedAt: b.ended_at, createdBy: b.created_by, createdAt: b.created_at,
});
const broadcastArea = requireArea('content', 'device');
fleet.get('/broadcasts', requireAuth, (_req, res) => res.json(all('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 100').map(broadcastOut)));
fleet.post('/broadcasts', broadcastArea, (req, res) => {
  const { title, message, style = 'alert', layout = 'full', targets = { all: true }, minutes, startsAt } = req.body || {};
  if (!String(message || '').trim()) throw new HttpError(400, 'Write a message');
  if (!['alert', 'warning', 'info'].includes(style) || !['full', 'banner'].includes(layout)) throw new HttpError(400, 'Unknown style');
  const bid = id();
  const start = startsAt ? new Date(startsAt) : new Date();
  const expires = Number(minutes) > 0 ? new Date(start.getTime() + Number(minutes) * 60e3).toISOString() : null;
  run('INSERT INTO broadcasts(id,title,message,style,layout,targets,starts_at,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    bid, title || '', message, style, layout, JSON.stringify(targets), start.toISOString(), expires, req.user.username, now());
  audit(req, 'broadcast.started', title || message.slice(0, 40));
  refreshPlayers();
  res.status(201).json(broadcastOut(get('SELECT * FROM broadcasts WHERE id=?', bid)));
});
fleet.post('/broadcasts/:id/end', broadcastArea, (req, res) => {
  const b = get('SELECT title,message FROM broadcasts WHERE id=?', req.params.id);
  if (!b) throw new HttpError(404, 'Not found');
  run('UPDATE broadcasts SET ended_at=? WHERE id=? AND ended_at IS NULL', now(), req.params.id);
  audit(req, 'broadcast.ended', b.title || b.message.slice(0, 40));
  refreshPlayers();
  res.json({ ok: true });
});

// ---------- overview & analytics ----------
fleet.get('/overview', requireAuth, (req, res) => {
  const screens = scoped(req.user, all('SELECT * FROM screens ORDER BY online DESC, name')).map(screenOut);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ids = new Set(screens.map((s) => s.id));
  const playsToday = all('SELECT screen_id, COUNT(*) AS n FROM play_events WHERE started_at>=? GROUP BY screen_id', today.toISOString())
    .filter((r) => ids.has(r.screen_id)).reduce((a, r) => a + r.n, 0);
  res.json({
    screens,
    counts: {
      screens: screens.length,
      online: screens.filter((s) => s.online).length,
      content: scoped(req.user, all('SELECT id,team_id FROM content')).length,
      playlists: scoped(req.user, all('SELECT id,team_id FROM playlists')).length,
      playsToday,
    },
    broadcasts: all(`SELECT * FROM broadcasts WHERE ended_at IS NULL AND (expires_at IS NULL OR expires_at>?)`, now()).map(broadcastOut),
    activity: ['owner', 'admin'].includes(req.user.role) ? all('SELECT action,entity,username,created_at AS at FROM audit ORDER BY id DESC LIMIT 8') : [],
  });
});

function statsRange(q) {
  const days = Math.min(Math.max(Number(q.days) || 7, 1), 366);
  const from = new Date(Date.now() - days * 864e5);
  const params = [from.toISOString()];
  let where = 'started_at>=?';
  if (q.screenId) { where += ' AND screen_id=?'; params.push(q.screenId); }
  return { days, where, params };
}
fleet.get('/insights', requireAuth, (req, res) => {
  const { days, where, params } = statsRange(req.query);
  res.json({
    days,
    totals: get(`SELECT COUNT(*) AS plays, COALESCE(SUM(seconds),0) AS seconds, COUNT(DISTINCT screen_id) AS screens, COUNT(DISTINCT content_id) AS items FROM play_events WHERE ${where}`, ...params),
    byContent: all(`SELECT content_id AS id, MAX(content_name) AS name, COUNT(*) AS plays, SUM(seconds) AS seconds FROM play_events WHERE ${where} GROUP BY content_id ORDER BY plays DESC LIMIT 15`, ...params),
    byScreen: all(`SELECT e.screen_id AS id, COALESCE(s.name,'Removed screen') AS name, COUNT(*) AS plays, SUM(e.seconds) AS seconds FROM play_events e LEFT JOIN screens s ON s.id=e.screen_id WHERE ${where.replaceAll('started_at', 'e.started_at').replaceAll('screen_id', 'e.screen_id')} GROUP BY e.screen_id ORDER BY plays DESC`, ...params),
    byDay: all(`SELECT substr(started_at,1,10) AS day, COUNT(*) AS plays, SUM(seconds) AS seconds FROM play_events WHERE ${where} GROUP BY day ORDER BY day`, ...params),
  });
});
fleet.get('/insights/export.csv', requireAuth, (req, res) => {
  const { where, params } = statsRange(req.query);
  const quote = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep names from running as spreadsheet formulas
    return `"${s.replaceAll('"', '""')}"`;
  };
  const rows = all(`SELECT e.started_at, e.seconds, e.content_name, COALESCE(s.name,'Removed screen') AS screen FROM play_events e LEFT JOIN screens s ON s.id=e.screen_id WHERE ${where.replaceAll('started_at', 'e.started_at').replaceAll('screen_id', 'e.screen_id')} ORDER BY e.started_at`, ...params);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="proof-of-play.csv"' });
  res.send(['started_at,seconds,content,screen', ...rows.map((r) => [r.started_at, r.seconds, r.content_name, r.screen].map(quote).join(','))].join('\n'));
});

// ---------- online/offline monitor ----------
export function startMonitor() {
  setInterval(() => {
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
    for (const s of all('SELECT id,name FROM screens WHERE online=1 AND last_seen<?', cutoff)) {
      run('UPDATE screens SET online=0 WHERE id=?', s.id);
      emit('screen.offline', { id: s.id, name: s.name });
      notifyAdmins({ type: 'screens' });
    }
  }, 15e3).unref();
}

// =============== player-facing ===============
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  let c = '';
  for (const b of crypto.randomBytes(6)) c += CODE_CHARS[b % CODE_CHARS.length];
  return c;
}

function screenByKey(key) {
  return key ? get('SELECT * FROM screens WHERE device_key_hash=?', sha256(String(key))) : null;
}

// A device announces itself; it stays unpaired, showing a code, until someone enters that code.
const registerHits = new Map();
playerApi.post('/register', (req, res) => {
  const key = String(req.body?.key || '');
  if (key.length < 20) throw new HttpError(400, 'Invalid device key');
  const hash = sha256(key);
  const screen = get('SELECT id,name FROM screens WHERE device_key_hash=?', hash);
  if (screen) return res.json({ paired: true, name: screen.name });
  const inviteHash = req.body?.invite ? sha256(String(req.body.invite)) : null;
  const invite = invites.get(inviteHash);
  if (invite) {
    invites.delete(inviteHash); // single use, so a QR code photographed later adds nothing
    if (invite.expires > Date.now()) {
      const name = uniqueName(deviceName(req.get('user-agent')));
      addScreen(hash, name, { teamId: invite.teamId });
      audit(req, 'screen.paired', name);
      return res.json({ paired: true, name });
    }
  }
  run('DELETE FROM pairings WHERE expires_at<?', now());
  let pairing = get('SELECT * FROM pairings WHERE device_key_hash=?', hash);
  if (!pairing) {
    // Each new code costs a table row, so limit how fast one address can mint them.
    const hits = (registerHits.get(req.ip) || []).filter((t) => Date.now() - t < 60e3);
    if (hits.length >= 20) throw new HttpError(429, 'Too many pairing requests');
    registerHits.set(req.ip, [...hits, Date.now()]);
    pairing = { code: newCode(), expires_at: new Date(Date.now() + 15 * 60e3).toISOString() };
    run('INSERT INTO pairings(code,device_key_hash,expires_at) VALUES(?,?,?)', pairing.code, hash, pairing.expires_at);
  }
  const ip = plainIp(req.ip);
  if (config.localSetup && PRIVATE_ADDRESS.test(ip)) waitingDevices.set(pairing.code, { device: deviceName(req.get('user-agent')), ip, seen: Date.now() });
  res.json({ paired: false, code: pairing.code, expiresAt: pairing.expires_at, listed: waitingDevices.has(pairing.code) });
});

function resolveTarget(req) {
  const { playlist, group, content } = req.query;
  const key = req.get('x-device-key') || req.query.key;
  if (key) {
    const screen = screenByKey(key);
    if (!screen) throw new HttpError(404, 'Unknown device');
    return { screen };
  }
  const isPublic = getSettings().publicPlayers;
  if (content) {
    if (!req.user) throw new HttpError(401, 'Sign in to preview');
    loadScoped(req, 'content', content);
    return { contentId: String(content) };
  }
  if (!req.user && !isPublic) throw new HttpError(403, 'Public player links are turned off in Settings');
  if (playlist) return { playlistId: String(playlist) };
  if (group) return { groupId: String(group) };
  throw new HttpError(400, 'Nothing to play');
}

playerApi.get('/manifest', (req, res) => {
  const target = resolveTarget(req);
  const manifest = buildManifest(target);
  if (!manifest) throw new HttpError(404, 'Not found');
  res.set('Cache-Control', 'no-store').json(manifest);
});

playerApi.get('/events', (req, res) => {
  const screen = screenByKey(req.query.key);
  // Anonymous and preview players still get live refreshes, keyed to no screen.
  if (!screen && !req.user && !getSettings().publicPlayers) throw new HttpError(403, 'Not allowed');
  addPlayerStream(req, res, screen?.id ?? null);
});

playerApi.get('/mirror', (req, res) => {
  const screen = screenByKey(req.get('x-device-key'));
  if (!screen) throw new HttpError(404, 'Unknown device');
  res.set('Cache-Control', 'no-store').json({ id: mirrorFor(screen.id)?.id || null });
});

// A plain <img> can show this stream, so it works in TV browsers without any video support.
playerApi.get('/mirror/:id/stream', (req, res) => {
  const screen = screenByKey(req.query.key);
  const m = mirrors.get(req.params.id);
  if (!screen || !m?.screens.has(screen.id)) throw new HttpError(404, 'Not found');
  res.set({ 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  if (m.frame) writeFrame(res, m.frame);
  m.viewers.add(res);
  req.on('close', () => m.viewers.delete(res));
});

playerApi.post('/heartbeat', (req, res) => {
  const screen = screenByKey(req.get('x-device-key'));
  if (!screen) throw new HttpError(404, 'Unknown device');
  const { resolution, nowPlaying, nowPlayingId, offlineReady, events, error } = req.body || {};
  if (error) playerErrors.set(screen.id, String(error).slice(0, 300)); else playerErrors.delete(screen.id);
  const wasOffline = !screen.online;
  run('UPDATE screens SET last_seen=?, online=1, ip=?, user_agent=?, resolution=?, now_playing=?, now_playing_id=?, offline_ready=? WHERE id=?',
    now(), req.ip, String(req.get('user-agent') || '').slice(0, 255), resolution ? String(resolution).slice(0, 20) : null,
    nowPlaying ? String(nowPlaying).slice(0, 200) : null, nowPlayingId ? String(nowPlayingId).slice(0, 40) : null, offlineReady ? 1 : 0, screen.id);
  if (Array.isArray(events) && events.length) {
    tx(() => {
      for (const e of events.slice(0, 5000)) {
        const t = new Date(e.at);
        if (Number.isNaN(t.getTime())) continue;
        run('INSERT INTO play_events(screen_id,content_id,content_name,playlist_id,started_at,seconds) VALUES(?,?,?,?,?,?)',
          screen.id, e.contentId ? String(e.contentId).slice(0, 40) : null, String(e.name || '').slice(0, 200), e.playlistId ? String(e.playlistId).slice(0, 40) : null, t.toISOString(), Math.min(Number(e.seconds) || 0, 86400));
      }
    });
  }
  if (wasOffline) emit('screen.online', { id: screen.id, name: screen.name });
  notifyAdmins({ type: 'screens' });
  res.json({ ok: true });
});
