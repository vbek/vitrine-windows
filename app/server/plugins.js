// Plugin loader. Each folder in /plugins has plugin.json and an optional index.js exporting:
//   render(type, config, ctx) -> HTML string for a custom content type (shown in a sandboxed iframe)
//   setup({ router, on, db, log }) -> called once at boot when the plugin is enabled
// Built-in content types appear here too so they can be toggled the same way.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { ROOT } from './config.js';
import { getSettings, all, get, run } from './db.js';
import { on } from './events.js';
import { safeFetch } from './safe-fetch.js';

export const CORE_TYPES = [
  { type: 'image', label: 'Images', description: 'PNG, JPEG, WebP, GIF, AVIF and SVG pictures.' },
  { type: 'video', label: 'Videos', description: 'MP4, WebM and MOV files that play to the end or for a set time.' },
  { type: 'url', label: 'Web pages', description: 'Any address that allows being embedded.' },
  { type: 'html', label: 'HTML editor', description: 'Write HTML, CSS and JavaScript with a live preview.' },
  { type: 'youtube', label: 'YouTube', description: 'Embed a video with sound off and no controls.' },
  { type: 'stream', label: 'Cameras and live streams', description: 'HLS, MJPEG, or RTSP and RTMP transcoded by FFmpeg.' },
  { type: 'folder', label: 'Folders', description: 'Play every picture and video in a directory on the server.' },
  { type: 'composition', label: 'Compositions', description: 'Lay out several pieces of content in zones.' },
  { type: 'text', label: 'Text', description: 'Styled messages with optional scrolling.' },
  { type: 'embed', label: 'Playlist embed', description: 'Use a playlist as one item of another playlist.' },
  { type: 'pdf', label: 'PDF import', description: 'Turn each page of a PDF into a picture.' },
];

const loaded = new Map();
const pluginDir = path.join(ROOT, 'plugins');

export async function loadPlugins(app) {
  if (!fs.existsSync(pluginDir)) return;
  const disabled = getSettings().disabledPlugins || [];
  for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginDir, entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
      const indexFile = path.join(dir, 'index.js');
      const mod = fs.existsSync(indexFile) ? await import(pathToFileURL(indexFile).href) : {};
      loaded.set(manifest.id, { manifest, mod });
      if (mod.setup && !disabled.includes(manifest.id)) {
        const router = express.Router();
        await mod.setup({ router, on, db: { all, get, run }, log: (...a) => console.log(`[${manifest.id}]`, ...a) });
        app.use(`/plugins/${manifest.id}`, (req, res, next) => (isEnabled(manifest.id) ? next() : res.sendStatus(404)), router);
      }
      console.log(`Plugin loaded: ${manifest.name}`);
    } catch (e) {
      console.error(`Plugin "${entry.name}" failed to load:`, e.message);
    }
  }
}

export const isEnabled = (pluginId) => !(getSettings().disabledPlugins || []).includes(pluginId);

export function pluginList() {
  const core = CORE_TYPES.map((c) => ({ id: `core.${c.type}`, name: c.label, description: c.description, core: true, enabled: isEnabled(`core.${c.type}`) }));
  const ext = [...loaded.values()].map(({ manifest: m }) => ({ id: m.id, name: m.name, description: m.description, version: m.version, core: false, enabled: isEnabled(m.id) }));
  return [...core, ...ext];
}

export function pluginTypes() {
  const out = [];
  for (const { manifest: m } of loaded.values()) {
    if (!isEnabled(m.id)) continue;
    for (const t of m.contentTypes || []) out.push({ ...t, plugin: m.id });
  }
  return out;
}

export function typeEnabled(type) {
  if (CORE_TYPES.some((c) => c.type === type)) return isEnabled(`core.${type}`);
  return pluginTypes().some((t) => t.type === type);
}
export const isPluginType = (type) => !CORE_TYPES.some((c) => c.type === type);

export async function renderPluginType(type, cfg) {
  for (const { manifest, mod } of loaded.values()) {
    if (isEnabled(manifest.id) && manifest.contentTypes?.some((t) => t.type === type)) {
      if (!mod.render) break;
      return mod.render(type, cfg, { safeFetch });
    }
  }
  return null;
}
