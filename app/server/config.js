import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

export const config = {
  port: Number(env.PORT || 3400),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.VITRINE_DATA_DIR || path.join(ROOT, 'data')),
  sslCert: env.VITRINE_SSL_CERT || '',
  sslKey: env.VITRINE_SSL_KEY || '',
  maxUploadMb: Number(env.VITRINE_MAX_UPLOAD_MB || 2048),
  trustProxy: env.VITRINE_TRUST_PROXY === 'true',
  localSetup: env.VITRINE_LOCAL_SETUP === 'true',
  ffmpeg: env.VITRINE_FFMPEG || 'ffmpeg',
  sessionDays: Number(env.VITRINE_SESSION_DAYS || 14),
  statsRetentionDays: Number(env.VITRINE_STATS_RETENTION_DAYS || 365),
};

config.mediaDir = path.join(config.dataDir, 'media');
config.streamDir = path.join(config.dataDir, 'streams');
config.backupDir = path.join(config.dataDir, 'backups');
config.dbPath = path.join(config.dataDir, 'vitrine.db');
// Directories that "Folder" content is allowed to read (mounted USB drives, shares...).
config.folderRoots = (env.VITRINE_FOLDER_ROOTS
  ? env.VITRINE_FOLDER_ROOTS.split(path.delimiter)
  : [path.join(config.dataDir, 'external')]).map((p) => path.resolve(p));
config.https = Boolean(config.sslCert && config.sslKey);

for (const d of [config.dataDir, config.mediaDir, config.streamDir, config.backupDir, ...config.folderRoots]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* a removable root may be absent */ }
}
