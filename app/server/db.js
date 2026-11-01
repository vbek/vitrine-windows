import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL, team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, lang TEXT, created_at TEXT NOT NULL, last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL, last_used TEXT
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL, team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  config TEXT NOT NULL DEFAULT '{}', file TEXT, thumb TEXT, mime TEXT, size INTEGER NOT NULL DEFAULT 0,
  duration REAL, width INTEGER, height INTEGER, tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slides (
  id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, content_id TEXT REFERENCES content(id) ON DELETE CASCADE,
  embed_playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,
  duration REAL NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 1, schedule TEXT NOT NULL DEFAULT '{"mode":"always"}'
);
CREATE INDEX IF NOT EXISTS slides_pl ON slides(playlist_id, position);
CREATE TABLE IF NOT EXISTS screen_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, device_key_hash TEXT UNIQUE, location TEXT,
  group_id TEXT REFERENCES screen_groups(id) ON DELETE SET NULL, playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL, settings TEXT NOT NULL DEFAULT '{}',
  last_seen TEXT, online INTEGER NOT NULL DEFAULT 0, ip TEXT, user_agent TEXT, resolution TEXT,
  now_playing TEXT, now_playing_id TEXT, offline_ready INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairings (code TEXT PRIMARY KEY, device_key_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, name TEXT,
  playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE, days TEXT NOT NULL DEFAULT '[]',
  from_time TEXT NOT NULL, to_time TEXT NOT NULL, start_date TEXT, end_date TEXT, priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rules_t ON rules(target_type, target_id);
CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY, title TEXT, message TEXT NOT NULL, style TEXT NOT NULL DEFAULT 'alert', layout TEXT NOT NULL DEFAULT 'full',
  targets TEXT NOT NULL DEFAULT '{"all":true}', starts_at TEXT, expires_at TEXT, ended_at TEXT, created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS play_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, screen_id TEXT NOT NULL, content_id TEXT, content_name TEXT, playlist_id TEXT,
  started_at TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pe_time ON play_events(started_at);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, username TEXT, action TEXT NOT NULL, entity TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["*"]', secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, last_status TEXT, last_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const stmtCache = new Map();
const prep = (sql) => {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
};
export const all = (sql, ...p) => prep(sql).all(...p);
export const get = (sql, ...p) => prep(sql).get(...p);
export const run = (sql, ...p) => prep(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const id = () => crypto.randomBytes(12).toString('base64url');
export const now = () => new Date().toISOString();
export const parse = (v, fallback) => { try { return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };

export const SETTING_DEFAULTS = {
  brandName: 'Vitrine', brandLogo: '', accent: '', publicPlayers: false, playerIntro: true,
  defaultDuration: 10, defaultTransition: 'fade', playerSnippet: '', language: 'en', disabledPlugins: [],
};

export function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = parse(r.value, null);
  return out;
}
export const setSetting = (key, value) =>
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
