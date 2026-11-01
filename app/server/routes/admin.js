// Settings, plugin toggles, webhooks, audit log, backups.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { all, get, run, id, now, parse, db, getSettings, setSetting, SETTING_DEFAULTS } from '../db.js';
import { HttpError, requireArea, requireAuth, can } from '../auth.js';
import { audit, addAdminStream, refreshPlayers, testWebhook } from '../events.js';
import { pluginList } from '../plugins.js';
import { config } from '../config.js';

export const admin = Router();
const security = requireArea('security');

admin.get('/events', requireAuth, (req, res) => addAdminStream(req, res));

admin.get('/settings', security, (_req, res) => res.json(getSettings()));
admin.patch('/settings', security, (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) {
    if (!(k in SETTING_DEFAULTS) || k === 'disabledPlugins') continue;
    // A snippet runs on every screen, so it's reserved for the owner.
    if (k === 'playerSnippet' && !can(req.user, 'owner')) throw new HttpError(403, 'Only the owner can edit the player snippet');
    if (k === 'accent' && v && !/^#[0-9a-f]{6}$/i.test(v)) throw new HttpError(400, 'Accent must be a hex color');
    setSetting(k, v);
  }
  audit(req, 'settings.updated', Object.keys(body).join(', '));
  refreshPlayers();
  res.json(getSettings());
});

admin.get('/plugins', security, (_req, res) => res.json(pluginList()));
admin.post('/plugins/:id/toggle', security, (req, res) => {
  const list = pluginList();
  if (!list.some((p) => p.id === req.params.id)) throw new HttpError(404, 'Not found');
  const disabled = new Set(getSettings().disabledPlugins || []);
  if (req.body?.enabled) disabled.delete(req.params.id); else disabled.add(req.params.id);
  setSetting('disabledPlugins', [...disabled]);
  audit(req, req.body?.enabled ? 'plugin.enabled' : 'plugin.disabled', req.params.id);
  refreshPlayers();
  res.json(pluginList());
});

const hookOut = (h) => ({ id: h.id, url: h.url, events: parse(h.events, []), secret: h.secret, enabled: Boolean(h.enabled), lastStatus: h.last_status, lastAt: h.last_at });
admin.get('/webhooks', security, (_req, res) => res.json(all('SELECT * FROM webhooks ORDER BY created_at').map(hookOut)));
admin.post('/webhooks', security, (req, res) => {
  const { url, events } = req.body || {};
  if (!/^https?:\/\//i.test(url || '')) throw new HttpError(400, 'Enter a full address starting with http:// or https://');
  const hid = id();
  run('INSERT INTO webhooks(id,url,events,secret,created_at) VALUES(?,?,?,?,?)', hid, url, JSON.stringify(events?.length ? events : ['*']), crypto.randomBytes(24).toString('hex'), now());
  audit(req, 'webhook.created', url);
  res.status(201).json(hookOut(get('SELECT * FROM webhooks WHERE id=?', hid)));
});
admin.delete('/webhooks/:id', security, (req, res) => {
  run('DELETE FROM webhooks WHERE id=?', req.params.id);
  audit(req, 'webhook.deleted', req.params.id);
  res.json({ ok: true });
});
admin.post('/webhooks/:id/test', security, async (req, res) => {
  const h = get('SELECT * FROM webhooks WHERE id=?', req.params.id);
  if (!h) throw new HttpError(404, 'Not found');
  res.json({ status: await testWebhook(h) });
});

admin.get('/audit', security, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(all('SELECT id,username,action,entity,detail,ip,created_at AS at FROM audit ORDER BY id DESC LIMIT ?', limit));
});

// A consistent snapshot of the database. Media files are backed up by copying data/media.
admin.get('/backup', requireArea('owner'), (req, res) => {
  const file = path.join(config.backupDir, `vitrine-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  audit(req, 'backup.downloaded');
  res.download(file, path.basename(file), () => fs.rm(file, { force: true }, () => {}));
});
