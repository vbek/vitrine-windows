// End-to-end API tests against a real server process with a throwaway data directory.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitrine-test-'));
const PORT = 34981;
const base = `http://127.0.0.1:${PORT}`;
let proc;

class Client {
  cookie = '';
  async req(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  get(u, h) { return this.req('GET', u, undefined, h); }
  post(u, b = {}, h) { return this.req('POST', u, b, h); }
  patch(u, b, h) { return this.req('PATCH', u, b, h); }
  del(u, h) { return this.req('DELETE', u, undefined, h); }
}
const owner = new Client();
const anon = new Client();

before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root, env: { ...process.env, PORT, HOST: '127.0.0.1', VITRINE_DATA_DIR: dataDir }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/api/auth/state`); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('server did not start');
});
after(async () => { proc.kill(); await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r))); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

async function login(name, password) {
  const c = new Client();
  const r = await c.post('/api/auth/login', { username: name, password });
  assert.equal(r.status, 200);
  return c;
}
const pairDevice = async (key, name, extra = {}) => {
  const reg = await anon.post('/player-api/register', { key });
  assert.equal(reg.body.paired, false);
  const r = await owner.post('/api/screens/pair', { code: reg.body.code, name, ...extra });
  assert.equal(r.status, 201);
  return r.body;
};

test('first run: setup creates the owner once, then locks', async () => {
  assert.equal((await anon.get('/api/auth/state')).body.needsSetup, true);
  assert.equal((await anon.get('/api/content')).status, 401);
  assert.equal((await owner.post('/api/auth/setup', { username: 'root', password: 'short' })).status, 400);
  const r = await owner.post('/api/auth/setup', { username: 'root', password: 'correct-horse' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'owner');
  assert.equal((await new Client().post('/api/auth/setup', { username: 'evil', password: 'password123' })).status, 409);
});

test('login: wrong password refused, session cookie is HttpOnly, logout works', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { username: 'root', password: 'nope' })).status, 401);
  const res = await c.post('/api/auth/login', { username: 'root', password: 'correct-horse' });
  assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(res.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.equal((await c.get('/api/content')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/content')).status, 401);
});

test('repeated failed logins are throttled', async () => {
  const c = new Client();
  await owner.post('/api/users', { username: 'victim', password: 'password-1', role: 'content' });
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/auth/login', { username: 'victim', password: 'wrong' });
  assert.equal(last.status, 429);
});

test('roles: content managers and device managers stay in their lane', async () => {
  await owner.post('/api/users', { username: 'carla', password: 'password-1', role: 'content' });
  await owner.post('/api/users', { username: 'dev', password: 'password-1', role: 'device' });
  const carla = await login('carla', 'password-1');
  const dev = await login('dev', 'password-1');
  assert.equal((await carla.post('/api/playlists', { name: 'mine' })).status, 201);
  assert.equal((await carla.post('/api/groups', { name: 'nope' })).status, 403);
  assert.equal((await carla.get('/api/users')).status, 403);
  assert.equal((await carla.patch('/api/settings', { brandName: 'hacked' })).status, 403);
  assert.equal((await dev.post('/api/playlists', { name: 'nope' })).status, 403);
  assert.equal((await dev.post('/api/groups', { name: 'ok' })).status, 201);
});

test('only one owner; admins cannot alter it or set the player snippet', async () => {
  await owner.post('/api/users', { username: 'adam', password: 'password-1', role: 'admin' });
  const adam = await login('adam', 'password-1');
  const users = (await adam.get('/api/users')).body;
  const root_ = users.find((u) => u.username === 'root');
  assert.equal((await owner.post('/api/users', { username: 'o2', password: 'password-1', role: 'owner' })).status, 400);
  assert.equal((await adam.patch(`/api/users/${root_.id}`, { password: 'hijacked-pw' })).status, 403);
  assert.equal((await adam.del(`/api/users/${root_.id}`)).status, 400);
  assert.equal((await adam.patch('/api/settings', { playerSnippet: '<script>x</script>' })).status, 403);
  assert.equal((await adam.get('/api/backup')).status, 403);
});

test('teams isolate content, and references across teams are refused', async () => {
  const a = (await owner.post('/api/teams', { name: 'A' })).body;
  const b = (await owner.post('/api/teams', { name: 'B' })).body;
  await owner.post('/api/users', { username: 'ann', password: 'password-1', role: 'content', teamId: a.id });
  await owner.post('/api/users', { username: 'bob', password: 'password-1', role: 'content', teamId: b.id });
  const ann = await login('ann', 'password-1');
  const bob = await login('bob', 'password-1');
  const item = (await ann.post('/api/content', { name: 'A secret', type: 'text', config: { text: 'x' } })).body;
  const annList = (await ann.post('/api/playlists', { name: 'A list' })).body;
  const bobList = (await bob.post('/api/playlists', { name: 'B list' })).body;
  assert.ok(!(await bob.get('/api/content')).body.some((c) => c.id === item.id));
  assert.equal((await bob.get(`/api/content/${item.id}`)).status, 404);
  assert.equal((await bob.del(`/api/content/${item.id}`)).status, 404);
  assert.equal((await bob.get(`/api/playlists/${annList.id}`)).status, 404);
  assert.equal((await bob.post(`/api/playlists/${bobList.id}/slides`, { contentId: item.id })).status, 404);
  assert.ok((await owner.get('/api/content')).body.some((c) => c.id === item.id));
});

test('content validation', async () => {
  const bad = async (type, config) => (await owner.post('/api/content', { name: 'x', type, config })).status;
  assert.equal(await bad('url', { url: 'javascript:alert(1)' }), 400);
  assert.equal(await bad('youtube', { url: 'https://example.com' }), 400);
  assert.equal(await bad('stream', { url: 'file:///etc/passwd' }), 400);
  assert.equal(await bad('folder', { path: 'C:\\Windows' }), 400);
  assert.equal(await bad('folder', { path: path.join(dataDir, 'external', '..', '..') }), 400);
  assert.equal(await bad('nonsense', {}), 400);
  assert.equal(await bad('youtube', { url: 'https://youtu.be/dQw4w9WgXcQ' }), 201);
});

test('uploads: images accepted with range-capable serving, scripts refused', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAcCBlCwAAAABJRU5ErkJggg==', 'base64');
  const send = (name, data, type) => {
    const form = new FormData();
    form.append('file', new Blob([data], { type }), name);
    return fetch(`${base}/api/content/upload`, { method: 'POST', body: form, headers: { cookie: owner.cookie } });
  };
  assert.equal((await send('evil.html', '<script>1</script>', 'text/html')).status, 415);
  assert.equal((await send('evil.js', 'alert(1)', 'text/javascript')).status, 415);
  const ok = await send('pixel.png', png, 'image/png');
  assert.equal(ok.status, 201);
  const item = await ok.json();
  assert.equal(item.type, 'image');
  const media = await fetch(base + item.url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(media.status, 206);
  assert.match(media.headers.get('content-security-policy'), /sandbox/);
  assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
});

test('playlists: slides, order, schedule validation, cycle refusal, flattening', async () => {
  const text = async (n) => (await owner.post('/api/content', { name: n, type: 'text', config: { text: n } })).body;
  const [a, b] = [await text('a'), await text('b')];
  const inner = (await owner.post('/api/playlists', { name: 'inner' })).body;
  const outer = (await owner.post('/api/playlists', { name: 'outer' })).body;
  await owner.post(`/api/playlists/${inner.id}/slides`, { items: [{ contentId: a.id }] });
  const withB = (await owner.post(`/api/playlists/${outer.id}/slides`, { items: [{ contentId: b.id }, { embedPlaylistId: inner.id }] })).body;
  assert.equal(withB.slides.length, 2);

  assert.equal((await owner.post(`/api/playlists/${inner.id}/slides`, { embedPlaylistId: outer.id })).status, 400, 'cycle');
  assert.equal((await owner.post(`/api/playlists/${outer.id}/slides`, { embedPlaylistId: outer.id })).status, 400, 'self');

  const order = withB.slides.map((s) => s.id).reverse();
  await owner.patch(`/api/playlists/${outer.id}/order`, { order });
  const after_ = (await owner.get(`/api/playlists/${outer.id}`)).body;
  assert.deepEqual(after_.slides.map((s) => s.id), order);

  const sid = after_.slides.find((s) => s.content).id;
  assert.equal((await owner.patch(`/api/slides/${sid}`, { schedule: { mode: 'bogus' } })).status, 400);
  assert.equal((await owner.patch(`/api/slides/${sid}`, { schedule: { mode: 'dates', start: '2026-02-01T00:00', end: '2026-01-01T00:00' } })).status, 400);
  assert.equal((await owner.patch(`/api/slides/${sid}`, { schedule: { mode: 'daily', days: [0], from: '09:00', to: '10:00' } })).status, 200);

  const m = (await owner.get(`/player-api/manifest?playlist=${outer.id}`)).body;
  assert.deepEqual(m.playlists[outer.id].slides.map((s) => s.name), ['a', 'b']);
  assert.equal(m.playlists[outer.id].slides[1].schedules[0].mode, 'daily');

  const dup = (await owner.post(`/api/playlists/${outer.id}/duplicate`)).body;
  assert.equal(dup.slideCount, 2);
});

test('pairing: unpaired devices get nothing; a code binds exactly once', async () => {
  const key = 'device-key-aaaaaaaaaaaaaaaaaaaaaa';
  assert.equal((await anon.post('/player-api/register', { key: 'short' })).status, 400);
  const reg = (await anon.post('/player-api/register', { key })).body;
  assert.match(reg.code, /^[A-Z2-9]{6}$/);
  assert.equal((await anon.post('/player-api/register', { key })).body.code, reg.code, 'stable while waiting');
  assert.equal((await anon.get('/player-api/manifest', { 'x-device-key': key })).status, 404);
  assert.equal((await owner.post('/api/screens/pair', { code: 'ZZZZZZ' })).status, 404);
  assert.equal((await anon.post('/api/screens/pair', { code: reg.code })).status, 401);
  const s = (await owner.post('/api/screens/pair', { code: reg.code.toLowerCase(), name: 'Lobby' })).body;
  assert.equal(s.name, 'Lobby');
  assert.equal((await owner.post('/api/screens/pair', { code: reg.code })).status, 404, 'single use');
  assert.equal((await anon.post('/player-api/register', { key })).body.paired, true);
  assert.equal((await anon.get('/player-api/manifest', { 'x-device-key': key })).status, 200);
});

test('QR invites: pair a device directly, once, and only for signed-in users', async () => {
  const origin = 'http://192.168.1.20';
  assert.equal((await anon.post('/api/screens/invites', { origin })).status, 401);
  assert.equal((await owner.post('/api/screens/invites', { origin: 'javascript:alert(1)' })).status, 400);
  const invite = (await owner.post('/api/screens/invites', { origin })).body;
  assert.match(invite.url, /^http:\/\/192\.168\.1\.20\/tv\?invite=[\w-]+$/);
  assert.match(invite.qr, /<svg/);
  const token = new URL(invite.url).searchParams.get('invite');
  const key = 'device-key-qrqrqrqrqrqrqrqrqrqrqr';
  assert.equal((await anon.post('/player-api/register', { key: 'device-key-wrongwrongwrongwrong', invite: 'nope' })).body.paired, false, 'a bad invite falls back to a code');
  assert.equal((await anon.post('/player-api/register', { key, invite: token })).body.paired, true);
  assert.equal((await anon.get('/player-api/manifest', { 'x-device-key': key })).status, 200);
  assert.equal((await anon.post('/player-api/register', { key: 'device-key-secondsecondsecondsec', invite: token })).body.paired, false, 'single use');
  assert.deepEqual((await owner.get('/api/screens/waiting')).body, { supported: false, waiting: [] }, 'no device list on a server install');
});

test('screen resolution: own playlist beats group, rules are delivered, removal unpairs', async () => {
  const p1 = (await owner.post('/api/playlists', { name: 'p1' })).body;
  const p2 = (await owner.post('/api/playlists', { name: 'p2' })).body;
  const p3 = (await owner.post('/api/playlists', { name: 'p3' })).body;
  const g = (await owner.post('/api/groups', { name: 'g', playlistId: p1.id })).body;
  const key = 'device-key-bbbbbbbbbbbbbbbbbbbbbb';
  const s = await pairDevice(key, 'S', { groupId: g.id });
  const man = async () => (await anon.get('/player-api/manifest', { 'x-device-key': key })).body;
  assert.equal((await man()).fallback, p1.id);
  await owner.patch(`/api/screens/${s.id}`, { playlistId: p2.id });
  assert.equal((await man()).fallback, p2.id);
  assert.equal((await owner.post('/api/rules', { targetType: 'screen', targetId: s.id, from: 'bad', to: '10:00' })).status, 400);
  await owner.post('/api/rules', { targetType: 'screen', targetId: s.id, playlistId: p3.id, from: '09:00', to: '10:00', days: [0] });
  await owner.post('/api/rules', { targetType: 'group', targetId: g.id, playlistId: null, from: '22:00', to: '06:00' });
  const m = await man();
  assert.equal(m.rules.length, 2);
  assert.ok(m.playlists[p3.id], 'rule playlists are shipped for offline use');
  await owner.del(`/api/screens/${s.id}`);
  assert.equal((await anon.get('/player-api/manifest', { 'x-device-key': key })).status, 404);
});

test('public player links are off by default, and previews need a session', async () => {
  const p = (await owner.post('/api/playlists', { name: 'pub' })).body;
  assert.equal((await anon.get(`/player-api/manifest?playlist=${p.id}`)).status, 403);
  assert.equal((await anon.get(`/player-api/manifest?content=whatever`)).status, 401);
  await owner.patch('/api/settings', { publicPlayers: true });
  assert.equal((await anon.get(`/player-api/manifest?playlist=${p.id}`)).status, 200);
  assert.equal((await anon.get(`/player-api/manifest?content=whatever`)).status, 401);
  await owner.patch('/api/settings', { publicPlayers: false });
});

test('broadcasts: targeting, expiry, ending', async () => {
  const k1 = 'device-key-cccccccccccccccccccccc', k2 = 'device-key-dddddddddddddddddddddd';
  const g = (await owner.post('/api/groups', { name: 'bc' })).body;
  await pairDevice(k1, 'in', { groupId: g.id });
  await pairDevice(k2, 'out');
  const bcs = async (k) => (await anon.get('/player-api/manifest', { 'x-device-key': k })).body.broadcasts;
  assert.equal((await owner.post('/api/broadcasts', {})).status, 400);
  const b = (await owner.post('/api/broadcasts', { message: 'fire', targets: { groups: [g.id] }, minutes: 5 })).body;
  assert.equal((await bcs(k1)).length, 1);
  assert.equal((await bcs(k2)).length, 0);
  await owner.post(`/api/broadcasts/${b.id}/end`);
  assert.equal((await bcs(k1)).length, 0);
});

test('heartbeat records status and proof of play; CSV neutralises formulas', async () => {
  const k = 'device-key-eeeeeeeeeeeeeeeeeeeeee';
  const s = await pairDevice(k, 'Reporter');
  assert.equal((await anon.post('/player-api/heartbeat', {}, { 'x-device-key': 'unknown-key-xxxxxxxxxxxxxxxxx' })).status, 404);
  await anon.post('/player-api/heartbeat', {
    resolution: '1920x1080', nowPlaying: 'Ad', offlineReady: true,
    events: [
      { contentId: 'c1', name: '=HYPERLINK("evil")', at: new Date().toISOString(), seconds: 10 },
      { contentId: 'c1', name: '=HYPERLINK("evil")', at: new Date().toISOString(), seconds: 10 },
      { contentId: 'c2', name: 'bad date', at: 'not-a-date', seconds: 10 },
    ],
  }, { 'x-device-key': k });
  const screens = (await owner.get('/api/screens')).body;
  const me = screens.find((x) => x.id === s.id);
  assert.equal(me.online, true);
  assert.equal(me.resolution, '1920x1080');
  assert.equal(me.offlineReady, true);
  const ins = (await owner.get(`/api/insights?days=7&screenId=${s.id}`)).body;
  assert.equal(ins.totals.plays, 2);
  assert.equal(ins.totals.seconds, 20);
  const csv = (await owner.get(`/api/insights/export.csv?days=7&screenId=${s.id}`)).body;
  assert.match(csv, /"'=HYPERLINK/);
});

test('API tokens: authenticate, inherit the role, can be revoked', async () => {
  const made = (await owner.post('/api/me/tokens', { name: 'ci' })).body;
  assert.match(made.token, /^vt_/);
  const auth = { Authorization: `Bearer ${made.token}` };
  assert.equal((await anon.get('/api/playlists', auth)).status, 200);
  assert.equal((await anon.get('/api/playlists', { Authorization: 'Bearer vt_wrong' })).status, 401);
  const listed = (await owner.get('/api/me/tokens')).body;
  assert.ok(!JSON.stringify(listed).includes(made.token), 'token is never listed again');
  await owner.del(`/api/me/tokens/${made.id}`);
  assert.equal((await anon.get('/api/playlists', auth)).status, 401);
});

test('two-factor: enrolment, required at login, replay refused', async () => {
  const { totpCode } = await import('./totp-helper.js');
  await owner.post('/api/users', { username: 'tina', password: 'password-1', role: 'content' });
  const tina = await login('tina', 'password-1');
  const { secret } = (await tina.post('/api/me/totp/start')).body;
  const counter = Math.floor(Date.now() / 30000);
  assert.equal((await tina.post('/api/me/totp/confirm', { code: '000000' })).status, 400);
  assert.equal((await tina.post('/api/me/totp/confirm', { code: totpCode(secret, counter - 1) })).status, 200);
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { username: 'tina', password: 'password-1' })).body.needsCode, true);
  assert.equal((await c.get('/api/content')).status, 401, 'password alone gives no session');
  assert.equal((await c.post('/api/auth/login', { username: 'tina', password: 'password-1', code: totpCode(secret, counter - 1) })).status, 401, 'used code refused');
  assert.equal((await c.post('/api/auth/login', { username: 'tina', password: 'password-1', code: totpCode(secret, counter) })).status, 200);
  assert.equal((await c.get('/api/content')).status, 200);
});

test('plugins: render in a sandbox, escape input, and can be turned off', async () => {
  const qr = (await owner.post('/api/content', { name: 'q', type: 'qr', config: { url: 'https://example.com', caption: '<img src=x onerror=alert(1)>' } })).body;
  const r = await anon.get(`/render/${qr.id}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.ok(!r.body.includes('<img src=x'), 'caption is escaped');
  await owner.post('/api/plugins/qr/toggle', { enabled: false });
  assert.equal((await owner.post('/api/content', { name: 'q2', type: 'qr', config: {} })).status, 400);
  assert.equal((await anon.get(`/render/${qr.id}`)).status, 404);
  await owner.post('/api/plugins/qr/toggle', { enabled: true });
});

test('RSS plugin refuses private addresses', async () => {
  const c = (await owner.post('/api/content', { name: 'r', type: 'rss', config: { url: `${base}/api/auth/state` } })).body;
  const r = await anon.get(`/render/${c.id}`);
  assert.match(r.body, /Private network addresses are not allowed/);
});

test('folder content: lists media only, and cannot escape its root', async () => {
  const root_ = path.join(dataDir, 'external', 'usb');
  fs.mkdirSync(root_, { recursive: true });
  fs.writeFileSync(path.join(root_, 'a.png'), 'x');
  fs.writeFileSync(path.join(root_, 'secret.txt'), 'x');
  const c = (await owner.post('/api/content', { name: 'usb', type: 'folder', config: { path: root_ } })).body;
  const p = (await owner.post('/api/playlists', { name: 'usbp' })).body;
  await owner.post(`/api/playlists/${p.id}/slides`, { contentId: c.id });
  const m = (await owner.get(`/player-api/manifest?playlist=${p.id}`)).body;
  assert.deepEqual(m.playlists[p.id].slides.map((s) => s.url), [`/folder-media/${c.id}/a.png`]);
  assert.equal((await fetch(`${base}/folder-media/${c.id}/a.png`)).status, 200);
  assert.equal((await fetch(`${base}/folder-media/${c.id}/secret.txt`)).status, 404);
  assert.equal((await fetch(`${base}/folder-media/${c.id}/..%2F..%2Fvitrine.db`)).status, 404);
});

test('webhooks are signed', async () => {
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { got.push({ headers: req.headers, body: b }); res.end('ok'); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const hook = (await owner.post('/api/webhooks', { url: `http://127.0.0.1:${srv.address().port}/h`, events: ['playlist.created'] })).body;
  await owner.post('/api/playlists', { name: 'hooked' });
  for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
  srv.close();
  assert.equal(got.length, 1);
  assert.equal(got[0].headers['x-vitrine-event'], 'playlist.created');
  const expected = crypto.createHmac('sha256', hook.secret).update(got[0].body).digest('hex');
  assert.equal(got[0].headers['x-vitrine-signature'], `sha256=${expected}`);
});

test('audit log and unknown API routes', async () => {
  const log = (await owner.get('/api/audit')).body;
  assert.ok(log.some((a) => a.action === 'user.login'));
  assert.equal((await owner.get('/api/nope')).status, 404);
});
