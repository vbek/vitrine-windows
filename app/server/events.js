// Server-sent events: pushes to players and studio tabs, plus outbound webhooks.
import crypto from 'node:crypto';
import { all, run, now, parse } from './db.js';

const players = new Map(); // connection -> { res, screenId, scope }
const admins = new Set();
const listeners = new Map();

function open(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
}
const send = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

export function addPlayerStream(req, res, screenId) {
  open(req, res);
  const conn = { res, screenId };
  players.set(conn, conn);
  req.on('close', () => players.delete(conn));
}
export function addAdminStream(req, res) {
  open(req, res);
  admins.add(res);
  req.on('close', () => admins.delete(res));
}
export const notifyAdmins = (data) => { for (const r of admins) send(r, data); };
export function sendToScreen(screenId, data) {
  let n = 0;
  for (const c of players.values()) if (c.screenId === screenId) { send(c.res, data); n++; }
  return n;
}

// Bursts of edits collapse to one refresh.
let refreshTimer = null;
export function refreshPlayers() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const c of players.values()) send(c.res, { type: 'refresh' });
    notifyAdmins({ type: 'changed' });
  }, 250);
  refreshTimer.unref?.();
}

setInterval(() => {
  for (const c of players.values()) c.res.write(': ping\n\n');
  for (const r of admins) r.write(': ping\n\n');
}, 25000).unref();

// ---------- hooks + webhooks ----------
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
}

async function deliver(hook, event, payload) {
  const body = JSON.stringify({ event, at: now(), data: payload });
  const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
  let status;
  try {
    const r = await fetch(hook.url, {
      method: 'POST', body, signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'X-Vitrine-Event': event, 'X-Vitrine-Signature': `sha256=${signature}` },
    });
    status = String(r.status);
  } catch (e) { status = `error: ${e.cause?.code || e.name}`; }
  run('UPDATE webhooks SET last_status=?, last_at=? WHERE id=?', status, now(), hook.id);
  return status;
}
export const testWebhook = (hook) => deliver(hook, 'webhook.test', { hello: 'from Vitrine' });

export function emit(event, payload = {}) {
  for (const fn of [...(listeners.get(event) || []), ...(listeners.get('*') || [])]) {
    try { fn(payload, event); } catch (e) { console.error('[hook]', event, e); }
  }
  for (const h of all('SELECT * FROM webhooks WHERE enabled=1')) {
    const events = parse(h.events, []);
    if (events.includes('*') || events.includes(event)) deliver(h, event, payload);
  }
}

export function audit(req, action, entity = '', detail = '') {
  run('INSERT INTO audit(user_id,username,action,entity,detail,ip,created_at) VALUES(?,?,?,?,?,?,?)',
    req.user?.id ?? null, req.user?.username ?? null, action, entity, detail, req.ip ?? null, now());
  emit(action, { entity, detail, by: req.user?.username ?? null });
}
