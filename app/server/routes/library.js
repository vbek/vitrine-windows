// Content library, folders, and playlists.
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { all, get, run, id, now, parse, tx, getSettings } from '../db.js';
import { config } from '../config.js';
import { HttpError, requireArea, requireAuth, loadScoped, scoped, teamFor } from '../auth.js';
import { audit, refreshPlayers } from '../events.js';
import { IMAGE_EXT, VIDEO_EXT, folderPathAllowed, listFolderMedia, youtubeId } from '../manifest.js';
import { CORE_TYPES, typeEnabled, pluginTypes, isPluginType } from '../plugins.js';
import { STREAM_URL, stopStream, ffmpegAvailable } from '../streams.js';

export const library = Router();
const contentArea = requireArea('content');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: config.mediaDir,
    filename: (_req, file, cb) => cb(null, `${id()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: config.maxUploadMb * 1048576 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext);
    cb(ok ? null : new HttpError(415, `File type ${ext || 'unknown'} is not supported`), ok);
  },
});

function contentOut(r, usage) {
  return {
    id: r.id, name: r.name, type: r.type, folderId: r.folder_id, teamId: r.team_id, config: parse(r.config, {}),
    url: r.file ? `/media/${r.file}` : null, thumb: r.thumb ? `/media/${r.thumb}` : (r.type === 'image' && r.file ? `/media/${r.file}` : null),
    mime: r.mime, size: r.size, duration: r.duration, width: r.width, height: r.height, tags: parse(r.tags, []),
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, usage: usage ?? 0,
  };
}

function usageCounts() {
  const counts = new Map();
  for (const r of all('SELECT content_id AS id, COUNT(DISTINCT playlist_id) AS c FROM slides WHERE content_id IS NOT NULL GROUP BY content_id')) counts.set(r.id, r.c);
  for (const r of all("SELECT config FROM content WHERE type='composition'")) {
    for (const z of parse(r.config, {}).zones || []) if (z.contentId) counts.set(z.contentId, (counts.get(z.contentId) || 0) + 1);
  }
  return counts;
}

/** Validate and normalise config by content type. Throws on anything unusable. */
function cleanConfig(req, type, cfg = {}) {
  switch (type) {
    case 'url':
      if (!/^https?:\/\//i.test(cfg.url || '')) throw new HttpError(400, 'Enter a full address starting with http:// or https://');
      break;
    case 'youtube':
      if (!youtubeId(cfg.url)) throw new HttpError(400, 'That does not look like a YouTube link');
      break;
    case 'stream':
      if (!STREAM_URL.test(cfg.url || '')) throw new HttpError(400, 'Enter a stream address starting with rtsp://, rtmp:// or http(s)://');
      if (/^(rtsp|rtmp)/i.test(cfg.url)) cfg.transcode = true;
      if (cfg.transcode) {
        // FFmpeg runs on the server and can reach its private network, so this needs more than content access.
        if (!['owner', 'admin'].includes(req.user.role)) throw new HttpError(403, 'Only an admin can add a stream that the server transcodes');
        if (!ffmpegAvailable()) throw new HttpError(400, 'FFmpeg is not installed on the server, so this stream cannot be transcoded');
      }
      break;
    case 'folder':
      if (!cfg.path || !folderPathAllowed(cfg.path)) throw new HttpError(400, `Folder must be inside an allowed location: ${config.folderRoots.join(', ')}`);
      break;
    case 'composition':
      cfg.zones = (cfg.zones || []).map((z) => ({
        x: clamp(z.x), y: clamp(z.y), w: clamp(z.w), h: clamp(z.h), z: Number(z.z) || 0,
        contentId: z.contentId || null, playlistId: z.playlistId || null, duration: Number(z.duration) || 0,
      }));
      break;
  }
  return cfg;
}
const clamp = (v) => Math.min(100, Math.max(0, Number(v) || 0));

// ---------- meta ----------
library.get('/content-types', requireAuth, (_req, res) => {
  res.json({
    core: CORE_TYPES.filter((c) => typeEnabled(c.type)).map((c) => c.type),
    plugins: pluginTypes(),
    folderRoots: config.folderRoots,
    ffmpeg: ffmpegAvailable(),
    maxUploadMb: config.maxUploadMb,
  });
});

// ---------- folders ----------
library.get('/folders', requireAuth, (req, res) => {
  res.json(scoped(req.user, all('SELECT * FROM folders ORDER BY name')).map((f) => ({ id: f.id, name: f.name, parentId: f.parent_id, teamId: f.team_id })));
});
library.post('/folders', contentArea, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new HttpError(400, 'Name the folder');
  const fid = id();
  run('INSERT INTO folders(id,name,parent_id,team_id,created_at) VALUES(?,?,?,?,?)', fid, name, req.body.parentId || null, teamFor(req.user), now());
  res.status(201).json({ id: fid, name, parentId: req.body.parentId || null });
});
library.patch('/folders/:id', contentArea, (req, res) => {
  const f = loadScoped(req, 'folders', req.params.id);
  run('UPDATE folders SET name=? WHERE id=?', String(req.body?.name || f.name), f.id);
  res.json({ ok: true });
});
library.delete('/folders/:id', contentArea, (req, res) => {
  const f = loadScoped(req, 'folders', req.params.id);
  run('DELETE FROM folders WHERE id=?', f.id); // items fall back to the library root
  res.json({ ok: true });
});

// ---------- content ----------
library.get('/content', requireAuth, (req, res) => {
  const usage = usageCounts();
  const rows = scoped(req.user, all('SELECT * FROM content ORDER BY created_at DESC'));
  res.json(rows.map((r) => contentOut(r, usage.get(r.id))));
});
library.get('/content/:id', requireAuth, (req, res) => {
  const r = loadScoped(req, 'content', req.params.id);
  const playlists = all('SELECT DISTINCT p.id, p.name FROM slides s JOIN playlists p ON p.id=s.playlist_id WHERE s.content_id=?', r.id);
  res.json({ ...contentOut(r, playlists.length), playlists });
});

library.post('/content/upload', contentArea, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), (req, res) => {
  const file = req.files?.file?.[0];
  if (!file) throw new HttpError(400, 'No file received');
  const thumb = req.files?.thumb?.[0];
  const ext = path.extname(file.filename);
  const type = IMAGE_EXT.has(ext) ? 'image' : 'video';
  if (!typeEnabled(type)) {
    fs.rmSync(file.path, { force: true });
    if (thumb) fs.rmSync(thumb.path, { force: true });
    throw new HttpError(400, `${type} content is turned off in Plugins`);
  }
  const cid = id();
  const ts = now();
  // Multer decodes file names as latin1.
  const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const name = req.body.name || path.basename(original, path.extname(original));
  run(`INSERT INTO content(id,name,type,folder_id,team_id,config,file,thumb,mime,size,duration,width,height,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    cid, name, type, req.body.folderId || null, teamFor(req.user), '{}', file.filename, thumb?.filename ?? null, MIME[ext],
    file.size, Number(req.body.duration) || null, Number(req.body.width) || null, Number(req.body.height) || null, req.user.username, ts, ts);
  audit(req, 'content.created', name, type);
  res.status(201).json(contentOut(get('SELECT * FROM content WHERE id=?', cid)));
});

library.post('/content', contentArea, (req, res) => {
  const { name, type, folderId, config: cfg, tags } = req.body || {};
  if (!name?.trim()) throw new HttpError(400, 'Give it a name');
  if (['image', 'video', 'pdf', 'embed'].includes(type)) throw new HttpError(400, 'This type is added another way');
  if (!CORE_TYPES.some((c) => c.type === type) && !pluginTypes().some((t) => t.type === type)) throw new HttpError(400, 'Unknown content type');
  if (!typeEnabled(type)) throw new HttpError(400, 'This content type is turned off in Plugins');
  const cid = id();
  const ts = now();
  run(`INSERT INTO content(id,name,type,folder_id,team_id,config,tags,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    cid, name.trim(), type, folderId || null, teamFor(req.user), JSON.stringify(cleanConfig(req, type, cfg)), JSON.stringify(tags || []), req.user.username, ts, ts);
  audit(req, 'content.created', name, type);
  res.status(201).json(contentOut(get('SELECT * FROM content WHERE id=?', cid)));
});

library.patch('/content/:id', contentArea, (req, res) => {
  const r = loadScoped(req, 'content', req.params.id);
  const { name, folderId, config: cfg, tags, teamId } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) throw new HttpError(400, 'Give it a name');
    run('UPDATE content SET name=? WHERE id=?', String(name).trim(), r.id);
  }
  if (folderId !== undefined) run('UPDATE content SET folder_id=? WHERE id=?', folderId || null, r.id);
  if (tags !== undefined) run('UPDATE content SET tags=? WHERE id=?', JSON.stringify(tags), r.id);
  if (cfg !== undefined) {
    run('UPDATE content SET config=? WHERE id=?', JSON.stringify(cleanConfig(req, r.type, cfg)), r.id);
    if (r.type === 'stream') stopStream(r.id);
  }
  if (teamId !== undefined && ['owner', 'admin'].includes(req.user.role)) run('UPDATE content SET team_id=? WHERE id=?', teamId || null, r.id);
  run('UPDATE content SET updated_at=? WHERE id=?', now(), r.id);
  audit(req, 'content.updated', r.name);
  refreshPlayers();
  res.json(contentOut(get('SELECT * FROM content WHERE id=?', r.id)));
});

library.delete('/content/:id', contentArea, (req, res) => {
  const r = loadScoped(req, 'content', req.params.id);
  run('DELETE FROM content WHERE id=?', r.id);
  for (const f of [r.file, r.thumb]) if (f) fs.rmSync(path.join(config.mediaDir, f), { force: true });
  if (r.type === 'stream') stopStream(r.id);
  audit(req, 'content.deleted', r.name, r.type);
  refreshPlayers();
  res.json({ ok: true });
});

library.get('/content/:id/folder-preview', requireAuth, (req, res) => {
  const r = loadScoped(req, 'content', req.params.id);
  res.json(listFolderMedia(parse(r.config, {}).path));
});

// ---------- playlists ----------
function slideOut(s) {
  const c = s.content_id ? get('SELECT * FROM content WHERE id=?', s.content_id) : null;
  const e = s.embed_playlist_id ? get('SELECT id,name FROM playlists WHERE id=?', s.embed_playlist_id) : null;
  return {
    id: s.id, position: s.position, duration: s.duration, enabled: Boolean(s.enabled), schedule: parse(s.schedule, { mode: 'always' }),
    content: c ? contentOut(c) : null, embed: e,
  };
}
function playlistOut(p, withSlides = false) {
  const stats = get(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN enabled=1 THEN duration ELSE 0 END),0) AS total FROM slides WHERE playlist_id=?`, p.id);
  const covers = withSlides ? [] : all(`SELECT c.thumb, c.file, c.type FROM slides s JOIN content c ON c.id=s.content_id WHERE s.playlist_id=? ORDER BY s.position LIMIT 12`, p.id)
    .map((c) => (c.thumb ? `/media/${c.thumb}` : c.type === 'image' && c.file ? `/media/${c.file}` : null)).filter(Boolean).slice(0, 4);
  const screens = get(`SELECT COUNT(*) AS n FROM screens s LEFT JOIN screen_groups g ON g.id=s.group_id WHERE s.playlist_id=? OR (s.playlist_id IS NULL AND g.playlist_id=?)`, p.id, p.id).n;
  return {
    id: p.id, name: p.name, description: p.description, teamId: p.team_id, settings: parse(p.settings, {}),
    slideCount: stats.n, totalDuration: stats.total, covers, screens, updatedAt: p.updated_at, createdAt: p.created_at,
    ...(withSlides ? { slides: all('SELECT * FROM slides WHERE playlist_id=? ORDER BY position', p.id).map(slideOut) } : {}),
  };
}
const touchPlaylist = (pid) => { run('UPDATE playlists SET updated_at=? WHERE id=?', now(), pid); refreshPlayers(); };

function embedsCycle(startId, targetId, seen = new Set()) {
  if (startId === targetId) return true;
  if (seen.has(startId)) return false;
  seen.add(startId);
  return all('SELECT embed_playlist_id AS e FROM slides WHERE playlist_id=? AND embed_playlist_id IS NOT NULL', startId).some((r) => embedsCycle(r.e, targetId, seen));
}

library.get('/playlists', requireAuth, (req, res) => {
  res.json(scoped(req.user, all('SELECT * FROM playlists ORDER BY updated_at DESC')).map((p) => playlistOut(p)));
});
library.post('/playlists', contentArea, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new HttpError(400, 'Name the playlist');
  const pid = id();
  const ts = now();
  run('INSERT INTO playlists(id,name,description,team_id,settings,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    pid, name, req.body.description || '', teamFor(req.user), JSON.stringify(req.body.settings || {}), ts, ts);
  audit(req, 'playlist.created', name);
  res.status(201).json(playlistOut(get('SELECT * FROM playlists WHERE id=?', pid), true));
});
library.get('/playlists/:id', requireAuth, (req, res) => res.json(playlistOut(loadScoped(req, 'playlists', req.params.id), true)));
library.patch('/playlists/:id', contentArea, (req, res) => {
  const p = loadScoped(req, 'playlists', req.params.id);
  const { name, description, settings, teamId } = req.body || {};
  if (name !== undefined) run('UPDATE playlists SET name=? WHERE id=?', String(name).trim() || p.name, p.id);
  if (description !== undefined) run('UPDATE playlists SET description=? WHERE id=?', String(description), p.id);
  if (settings !== undefined) run('UPDATE playlists SET settings=? WHERE id=?', JSON.stringify(settings), p.id);
  if (teamId !== undefined && ['owner', 'admin'].includes(req.user.role)) run('UPDATE playlists SET team_id=? WHERE id=?', teamId || null, p.id);
  touchPlaylist(p.id);
  audit(req, 'playlist.updated', p.name);
  res.json(playlistOut(get('SELECT * FROM playlists WHERE id=?', p.id), true));
});
library.delete('/playlists/:id', contentArea, (req, res) => {
  const p = loadScoped(req, 'playlists', req.params.id);
  run('DELETE FROM playlists WHERE id=?', p.id);
  audit(req, 'playlist.deleted', p.name);
  refreshPlayers();
  res.json({ ok: true });
});
library.post('/playlists/:id/duplicate', contentArea, (req, res) => {
  const p = loadScoped(req, 'playlists', req.params.id);
  const pid = id();
  const ts = now();
  tx(() => {
    run('INSERT INTO playlists(id,name,description,team_id,settings,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', pid, `${p.name} copy`, p.description, p.team_id, p.settings, ts, ts);
    for (const s of all('SELECT * FROM slides WHERE playlist_id=?', p.id)) {
      run('INSERT INTO slides(id,playlist_id,position,content_id,embed_playlist_id,duration,enabled,schedule) VALUES(?,?,?,?,?,?,?,?)', id(), pid, s.position, s.content_id, s.embed_playlist_id, s.duration, s.enabled, s.schedule);
    }
  });
  res.status(201).json(playlistOut(get('SELECT * FROM playlists WHERE id=?', pid)));
});

// ---------- slides ----------
library.post('/playlists/:id/slides', contentArea, (req, res) => {
  const p = loadScoped(req, 'playlists', req.params.id);
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  const defaults = getSettings();
  tx(() => {
    let pos = get('SELECT COALESCE(MAX(position),-1) AS m FROM slides WHERE playlist_id=?', p.id).m;
    for (const it of items) {
      if (it.embedPlaylistId) {
        loadScoped(req, 'playlists', it.embedPlaylistId);
        if (embedsCycle(it.embedPlaylistId, p.id)) throw new HttpError(400, 'A playlist cannot include itself, directly or through another playlist');
        run('INSERT INTO slides(id,playlist_id,position,embed_playlist_id,duration) VALUES(?,?,?,?,0)', id(), p.id, ++pos, it.embedPlaylistId);
      } else {
        const c = loadScoped(req, 'content', it.contentId);
        const duration = it.duration ?? (c.type === 'video' ? 0 : defaults.defaultDuration);
        run('INSERT INTO slides(id,playlist_id,position,content_id,duration,schedule) VALUES(?,?,?,?,?,?)', id(), p.id, ++pos, c.id, duration, JSON.stringify(it.schedule || { mode: 'always' }));
      }
    }
  });
  touchPlaylist(p.id);
  res.status(201).json(playlistOut(get('SELECT * FROM playlists WHERE id=?', p.id), true));
});

library.patch('/playlists/:id/order', contentArea, (req, res) => {
  const p = loadScoped(req, 'playlists', req.params.id);
  tx(() => (req.body?.order || []).forEach((sid, i) => run('UPDATE slides SET position=? WHERE id=? AND playlist_id=?', i, sid, p.id)));
  touchPlaylist(p.id);
  res.json({ ok: true });
});

function validateSchedule(s) {
  if (!['always', 'dates', 'week', 'daily'].includes(s?.mode)) throw new HttpError(400, 'Unknown schedule mode');
  if (s.mode === 'dates' && s.start && s.end && new Date(s.end) <= new Date(s.start)) throw new HttpError(400, 'The end must be after the start');
  return s;
}

library.patch('/slides/:id', contentArea, (req, res) => {
  const s = get('SELECT * FROM slides WHERE id=?', req.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  loadScoped(req, 'playlists', s.playlist_id);
  const { duration, enabled, schedule } = req.body || {};
  if (duration !== undefined) {
    if (!(Number(duration) >= 0)) throw new HttpError(400, 'Duration must be zero or more');
    run('UPDATE slides SET duration=? WHERE id=?', Number(duration), s.id);
  }
  if (enabled !== undefined) run('UPDATE slides SET enabled=? WHERE id=?', enabled ? 1 : 0, s.id);
  if (schedule !== undefined) run('UPDATE slides SET schedule=? WHERE id=?', JSON.stringify(validateSchedule(schedule)), s.id);
  touchPlaylist(s.playlist_id);
  res.json(slideOut(get('SELECT * FROM slides WHERE id=?', s.id)));
});

library.delete('/slides/:id', contentArea, (req, res) => {
  const s = get('SELECT * FROM slides WHERE id=?', req.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  loadScoped(req, 'playlists', s.playlist_id);
  run('DELETE FROM slides WHERE id=?', s.id);
  touchPlaylist(s.playlist_id);
  res.json({ ok: true });
});
