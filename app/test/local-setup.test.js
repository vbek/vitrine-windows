// The desktop app's rule: only the computer running Vitrine can create the owner account.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitrine-setup-'));
const PORT = 34982;
const lanIp = Object.values(os.networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal)?.address;
const owner = { username: 'owner', password: 'correct-horse' };
let proc;

// http.request, because fetch refuses to set a Host header.
const send = (method, address, urlPath, body, host) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : '';
  const req = http.request({
    host: address, port: PORT, path: urlPath, method,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(host ? { Host: host } : {}) },
  }, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
  });
  req.on('error', reject);
  req.end(data);
});

before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root, env: { ...process.env, PORT, HOST: '0.0.0.0', VITRINE_DATA_DIR: dataDir, VITRINE_LOCAL_SETUP: 'true' }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await send('GET', '127.0.0.1', '/api/auth/state'); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('server did not start');
});
after(async () => {
  proc.kill();
  await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('another device cannot create the owner', { skip: !lanIp && 'no network address' }, async () => {
  assert.equal((await send('GET', lanIp, '/api/auth/state')).body.setupBlocked, true);
  assert.equal((await send('POST', lanIp, '/api/auth/setup', owner)).status, 403);
});

test('a rebinding host name cannot create the owner', async () => {
  assert.equal((await send('POST', '127.0.0.1', '/api/auth/setup', owner, 'evil.example:3400')).status, 403);
});

test('this computer can create the owner, and other devices can then sign in', async () => {
  assert.equal((await send('GET', '127.0.0.1', '/api/auth/state', null, `localhost:${PORT}`)).body.setupBlocked, false);
  assert.equal((await send('POST', '127.0.0.1', '/api/auth/setup', owner, `localhost:${PORT}`)).status, 200);
  if (!lanIp) return;
  const fromLan = (await send('GET', lanIp, '/api/auth/state')).body;
  assert.equal(fromLan.setupBlocked, false);
  assert.equal(fromLan.screenOrigin, null);
  assert.equal((await send('POST', lanIp, '/api/auth/login', owner)).status, 200);
});
