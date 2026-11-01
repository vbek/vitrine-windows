// Builds what a player needs to run on its own: every playlist it could show, the rules that
// choose between them, and active broadcasts. The player evaluates schedules locally.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, parse, getSettings } from './db.js';
import { config } from './config.js';
import { typeEnabled, isPluginType } from './plugins.js';
import { broadcastActive } from '../shared/schedule.js';

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp']);
export const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);

export function folderPathAllowed(p) {
  const resolved = path.resolve(p);
  return config.folderRoots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
}

export function listFolderMedia(dir) {
  if (!dir || !folderPathAllowed(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .filter((n) => { const x = path.extname(n).toLowerCase(); return IMAGE_EXT.has(x) || VIDEO_EXT.has(x); })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch { return []; }
}

export function youtubeId(url) {
  const s = String(url || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  return /(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(s)?.[1] || null;
}

function contentSlides(row, duration, schedules, ctx, depth) {
  if (!row || !typeEnabled(row.type)) return [];
  const cfg = parse(row.config, {});
  const base = { contentId: row.id, name: row.name, type: row.type, duration, schedules };
  switch (row.type) {
    case 'image':
    case 'video':
      return [{ ...base, url: `/media/${row.file}`, fit: cfg.fit || 'contain', muted: cfg.muted !== false, cache: true }];
    case 'url':
      return [{ ...base, url: cfg.url, network: true, refresh: Number(cfg.refresh) || 0 }];
    case 'youtube':
      return [{ ...base, videoId: youtubeId(cfg.url), network: true, muted: cfg.muted !== false }];
    case 'html':
      return [{ ...base, html: cfg.html || '' }];
    case 'text':
      return [{ ...base, text: cfg }];
    case 'stream':
      return [{ ...base, network: true, url: cfg.transcode ? `/streams/${row.id}/index.m3u8` : cfg.url, kind: cfg.transcode ? 'hls' : (cfg.kind || 'hls'), muted: cfg.muted !== false }];
    case 'folder':
      return listFolderMedia(cfg.path).map((file) => {
        const video = VIDEO_EXT.has(path.extname(file).toLowerCase());
        return { ...base, name: `${row.name} / ${file}`, type: video ? 'video' : 'image', url: `/folder-media/${row.id}/${encodeURIComponent(file)}`, fit: cfg.fit || 'contain', muted: true, cache: true, duration: video && cfg.videoFull !== false ? 0 : duration };
      });
    case 'composition': {
      if (depth > 3) return [];
      const zones = (cfg.zones || []).map((z) => ({
        x: z.x, y: z.y, w: z.w, h: z.h, z: z.z || 0,
        slides: z.playlistId
          ? expandPlaylist(z.playlistId, [], ctx, depth + 1)
          : z.contentId ? contentSlides(get('SELECT * FROM content WHERE id=?', z.contentId), Number(z.duration) || 0, [], ctx, depth + 1).map((x, i) => ({ ...x, id: `z:${z.contentId}:${i}`, fit: parse(get('SELECT config FROM content WHERE id=?', z.contentId).config, {}).fit || 'cover' })) : [],
      }));
      return [{ ...base, zones, bg: cfg.bg || '#000000' }];
    }
    default:
      return isPluginType(row.type) ? [{ ...base, url: `/render/${row.id}`, network: true, plugin: true }] : [];
  }
}

function expandPlaylist(playlistId, inherited, ctx, depth = 0) {
  // Guard against a playlist embedding itself, directly or through others.
  if (depth > 6 || ctx.stack.includes(playlistId)) return [];
  ctx.stack.push(playlistId);
  const out = [];
  for (const s of all('SELECT * FROM slides WHERE playlist_id=? AND enabled=1 ORDER BY position', playlistId)) {
    const schedules = [...inherited, parse(s.schedule, { mode: 'always' })];
    if (s.embed_playlist_id) {
      if (typeEnabled('embed')) out.push(...expandPlaylist(s.embed_playlist_id, schedules, ctx, depth + 1));
    } else if (s.content_id) {
      const row = get('SELECT * FROM content WHERE id=?', s.content_id);
      out.push(...contentSlides(row, s.duration, schedules, ctx, depth).map((x, i) => ({ ...x, id: `${s.id}:${i}` })));
    }
  }
  ctx.stack.pop();
  return out;
}

const playlistPayload = (pl, ctx) => ({ id: pl.id, name: pl.name, settings: parse(pl.settings, {}), slides: expandPlaylist(pl.id, [], ctx) });

const ruleOut = (r) => ({ id: r.id, name: r.name, playlistId: r.playlist_id, days: parse(r.days, []), from: r.from_time, to: r.to_time, startDate: r.start_date, endDate: r.end_date, priority: r.priority });

function broadcastsFor(screen) {
  const out = [];
  for (const b of all('SELECT * FROM broadcasts WHERE ended_at IS NULL')) {
    const t = parse(b.targets, { all: true });
    const hit = t.all || !screen || t.screens?.includes(screen.id) || (screen.group_id && t.groups?.includes(screen.group_id));
    const item = { id: b.id, title: b.title, message: b.message, style: b.style, layout: b.layout, startsAt: b.starts_at, expiresAt: b.expires_at };
    if (hit && (!b.expires_at || broadcastActive({ expiresAt: b.expires_at }))) out.push(item);
  }
  return out;
}

/** target: { screen } | { playlistId } | { groupId } | { contentId } */
export function buildManifest(target) {
  const ctx = { stack: [] };
  const settings = getSettings();
  const playlists = {};
  let fallback = null;
  let rules = [];
  let screenSettings = {};
  let screenInfo = null;

  const add = (plId) => {
    if (!plId || playlists[plId]) return;
    const pl = get('SELECT * FROM playlists WHERE id=?', plId);
    if (pl) playlists[plId] = playlistPayload(pl, ctx);
  };

  if (target.screen || target.groupId) {
    const s = target.screen;
    const groupId = s ? s.group_id : target.groupId;
    const group = groupId ? get('SELECT * FROM screen_groups WHERE id=?', groupId) : null;
    if (target.groupId && !group) return null;
    fallback = s?.playlist_id || group?.playlist_id || null;
    add(fallback);
    const rows = [
      ...(s ? all("SELECT * FROM rules WHERE target_type='screen' AND target_id=?", s.id) : []),
      ...(group ? all("SELECT * FROM rules WHERE target_type='group' AND target_id=?", group.id) : []),
    ];
    rules = rows.map(ruleOut);
    rows.forEach((r) => add(r.playlist_id));
    if (s) {
      screenSettings = parse(s.settings, {});
      screenInfo = { id: s.id, name: s.name };
    }
  } else if (target.playlistId) {
    add(target.playlistId);
    if (!playlists[target.playlistId]) return null;
    fallback = target.playlistId;
  } else if (target.contentId) {
    const row = get('SELECT * FROM content WHERE id=?', target.contentId);
    if (!row) return null;
    const cfg = parse(row.config, {});
    const duration = row.type === 'video' ? 0 : Number(cfg.previewDuration) || settings.defaultDuration;
    const slides = contentSlides(row, duration, [], ctx, 0).map((x, i) => ({ ...x, id: `p:${i}` }));
    playlists.preview = { id: 'preview', name: row.name, settings: {}, slides };
    fallback = 'preview';
  }

  const body = {
    screen: screenInfo,
    screenSettings,
    playlists,
    fallback,
    rules,
    broadcasts: target.contentId || target.playlistId ? [] : broadcastsFor(target.screen || { group_id: target.groupId }),
    brand: { name: settings.brandName, logo: settings.brandLogo },
    defaults: { transition: settings.defaultTransition, intro: settings.playerIntro },
    snippet: settings.playerSnippet || '',
  };
  return { ...body, version: crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16) };
}
