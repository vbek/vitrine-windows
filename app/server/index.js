import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ROOT, config } from './config.js';
import { get, parse, run, all } from './db.js';
import { authenticate, HttpError, purgeSessions } from './auth.js';
import { account } from './routes/account.js';
import { library } from './routes/library.js';
import { fleet, playerApi, startMonitor } from './routes/fleet.js';
import { admin } from './routes/admin.js';
import { openapi } from './openapi.js';
import { loadPlugins, renderPluginType } from './plugins.js';
import { folderPathAllowed, VIDEO_EXT, IMAGE_EXT } from './manifest.js';
import { streamDir, touchStream, stopAllStreams } from './streams.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

const pub = path.join(ROOT, 'public');
const nm = path.join(ROOT, 'node_modules');

app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});

// ---------- static assets, all served locally so an isolated network works ----------
const longCache = { maxAge: '7d' };
app.use('/fonts/display', express.static(path.join(nm, '@fontsource-variable/bricolage-grotesque/files'), longCache));
app.use('/fonts/body', express.static(path.join(nm, '@fontsource-variable/instrument-sans/files'), longCache));
app.use('/fonts/mono', express.static(path.join(nm, '@fontsource-variable/jetbrains-mono/files'), longCache));
app.get('/vendor/hls.min.js', (_q, r) => r.sendFile(path.join(nm, 'hls.js/dist/hls.min.js')));
app.get('/vendor/Sortable.min.js', (_q, r) => r.sendFile(path.join(nm, 'sortablejs/Sortable.min.js')));
app.get('/vendor/pdf.min.mjs', (_q, r) => r.sendFile(path.join(nm, 'pdfjs-dist/build/pdf.min.mjs')));
app.get('/vendor/pdf.worker.min.mjs', (_q, r) => r.sendFile(path.join(nm, 'pdfjs-dist/build/pdf.worker.min.mjs')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/static', express.static(pub, { etag: true, maxAge: 0 }));
app.get('/player-sw.js', (_q, r) => r.set('Cache-Control', 'no-cache').sendFile(path.join(pub, 'player/sw.js')));

// Uploaded files are shown by players with no session, so names are unguessable.
// The sandbox header stops an uploaded SVG running script if opened directly.
const sandboxMedia = (res) => {
  res.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'");
  res.set('Access-Control-Allow-Origin', '*');
};
app.use('/media', express.static(config.mediaDir, { maxAge: '30d', immutable: true, setHeaders: sandboxMedia, index: false }));

app.get('/folder-media/:id/:file', (req, res) => {
  const c = get("SELECT config FROM content WHERE id=? AND type='folder'", req.params.id);
  if (!c) throw new HttpError(404, 'Not found');
  const dir = parse(c.config, {}).path;
  const name = path.basename(req.params.file);
  const ext = path.extname(name).toLowerCase();
  if (!folderPathAllowed(dir) || name.startsWith('.') || !(IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext))) throw new HttpError(404, 'Not found');
  sandboxMedia(res);
  res.sendFile(path.join(path.resolve(dir), name), { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.sendStatus(404); });
});

app.get('/streams/:id/:file', (req, res) => {
  const c = get("SELECT config FROM content WHERE id=? AND type='stream'", req.params.id);
  const cfg = c ? parse(c.config, {}) : null;
  const name = path.basename(req.params.file);
  if (!cfg?.transcode || !/^[\w.-]+\.(m3u8|ts)$/.test(name)) throw new HttpError(404, 'Not found');
  touchStream(req.params.id, cfg.url);
  const file = path.join(streamDir(req.params.id), name);
  // The first playlist takes a few seconds to appear after FFmpeg starts.
  let tries = 0;
  const attempt = () => {
    if (fs.existsSync(file)) return res.set('Cache-Control', 'no-store').sendFile(file);
    if (++tries > 40 || res.destroyed) return res.sendStatus(404);
    setTimeout(attempt, 250);
  };
  attempt();
});

// Plugin content types render in a sandboxed frame.
app.get('/render/:id', async (req, res) => {
  const c = get('SELECT type,config FROM content WHERE id=?', req.params.id);
  if (!c) throw new HttpError(404, 'Not found');
  const html = await renderPluginType(c.type, parse(c.config, {}));
  if (html == null) throw new HttpError(404, 'This content type is not available');
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': 'sandbox allow-scripts', 'Cache-Control': 'no-store' }).send(html);
});

// ---------- APIs ----------
app.use(express.json({ limit: '4mb' }));
app.use(authenticate);
app.get('/api/openapi.json', (_q, r) => r.json(openapi()));
app.use('/player-api', playerApi);
app.use('/api', account, library, fleet, admin);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// ---------- pages ----------
const playerPage = (_q, r) => r.set('Cache-Control', 'no-cache').sendFile(path.join(pub, 'player/index.html'));
app.get(['/tv', '/use/:id', '/group/:id', '/preview'], playerPage);

await loadPlugins(app);

// Everything else is the studio app, which handles its own routes.
app.get('/{*any}', (_q, r) => {
  r.set({ 'Cache-Control': 'no-cache', 'X-Frame-Options': 'SAMEORIGIN' }).sendFile(path.join(pub, 'app/index.html'));
});

app.use((err, req, res, _next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message;
  if (err.code === 'LIMIT_FILE_SIZE') { status = 413; message = `File is larger than the ${config.maxUploadMb} MB limit`; }
  if (status >= 500) { console.error(err); message = 'Something went wrong on the server'; }
  if (res.headersSent) return res.end();
  res.status(status).json({ error: message });
});

// ---------- start ----------
const server = config.https
  ? https.createServer({ cert: fs.readFileSync(config.sslCert), key: fs.readFileSync(config.sslKey) }, app)
  : http.createServer(app);

startMonitor();
setInterval(() => {
  purgeSessions();
  run('DELETE FROM play_events WHERE started_at<?', new Date(Date.now() - config.statsRetentionDays * 864e5).toISOString());
}, 36e5).unref();

server.listen(config.port, config.host, () => {
  console.log(`Vitrine is running at ${config.https ? 'https' : 'http'}://localhost:${config.port}`);
  if (!all('SELECT id FROM users LIMIT 1').length) console.log('Open it in a browser to create the owner account.');
});

// Typing a colon on a TV remote is slow, so also answer on port 80 when nothing else is using it.
if (config.shortAddress && !config.https) {
  http.createServer(app).on('error', () => {}).listen(80, config.host, () => { config.shortAddressActive = true; });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopAllStreams(); process.exit(0); });
}
