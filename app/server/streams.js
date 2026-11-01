// On-demand RTSP/RTMP to HLS via FFmpeg. A stream starts when a player asks for it and is
// stopped once nobody has requested a segment for a while, so idle cameras cost nothing.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const running = new Map(); // contentId -> { proc, dir, lastHit }
const lastExit = new Map();
const IDLE_MS = 45000;
const RETRY_MS = 8000;

export const ffmpegAvailable = (() => {
  let cached;
  return () => {
    if (cached === undefined) cached = spawnSync(config.ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
    return cached;
  };
})();

export const STREAM_URL = /^(rtsps?|rtmps?|https?):\/\//i;

function start(contentId, url) {
  if (!STREAM_URL.test(url)) throw new Error('Unsupported stream address');
  const dir = path.join(config.streamDir, contentId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const input = /^rtsp/i.test(url) ? ['-rtsp_transport', 'tcp'] : [];
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file,tcp,udp,rtp,rtsp,rtsps,rtmp,rtmps,http,https,tls,crypto',
    ...input, '-i', url,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '48', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6', '-hls_flags', 'delete_segments+omit_endlist',
    path.join(dir, 'index.m3u8'),
  ];
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => console.error(`[stream ${contentId}]`, String(d).trim().slice(0, 300)));
  const entry = { proc, dir, lastHit: Date.now() };
  const ended = () => {
    if (running.get(contentId) === entry) running.delete(contentId);
    lastExit.set(contentId, Date.now());
    // A leftover playlist would make a dead source look live.
    fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
  };
  proc.on('exit', ended);
  proc.on('error', (e) => { console.error(`[stream ${contentId}]`, e.message); ended(); });
  running.set(contentId, entry);
  return entry;
}

/** Keeps a wanted stream running. While a source is down, retries are spaced out rather than made on every request. */
export function touchStream(contentId, url) {
  let entry = running.get(contentId);
  if (!entry && Date.now() - (lastExit.get(contentId) || 0) > RETRY_MS) entry = start(contentId, url);
  if (entry) entry.lastHit = Date.now();
}

export const streamDir = (contentId) => path.join(config.streamDir, contentId);

export function stopStream(contentId) {
  const e = running.get(contentId);
  if (e) { running.delete(contentId); e.proc.kill(); }
}
export const stopAllStreams = () => { for (const k of [...running.keys()]) stopStream(k); };

setInterval(() => {
  for (const [k, e] of running) if (Date.now() - e.lastHit > IDLE_MS) stopStream(k);
}, 10000).unref();
