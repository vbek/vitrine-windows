import { allActive, pickPlaylist, broadcastActive } from '/shared/schedule.js';

const qs = new URLSearchParams(location.search);
const path = location.pathname.split('/').filter(Boolean);
const route = path[0]; // tv | use | group | preview
const stage = document.getElementById('stage');
const isPreview = route === 'preview';
const param = (k, d) => qs.get(k) ?? d;

const SPEEDS = { slow: 1.3, normal: 0.7, fast: 0.35 };
const DIRS = { left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] };
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- local storage + media cache ----------
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`vt.${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`vt.${k}`, JSON.stringify(v)); } catch { /* full or blocked */ } },
};

const mediaDb = (() => {
  let dbp;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('vitrine-media', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('media');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('media', mode);
      const q = fn(t.objectStore('media'));
      t.oncomplete = () => res(q?.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    put: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
    keys: () => tx('readonly', (s) => s.getAllKeys()),
  };
})();

const cachedUrls = new Set();
const brokenCopies = new Set(); // saved copies this browser could not display
let caching = false;
async function syncMediaCache(manifest) {
  if (isPreview || caching) return;
  caching = true;
  try {
    const wanted = new Set();
    const walk = (slides) => slides.forEach((s) => { if (s.cache && s.url) wanted.add(s.url); if (s.zones) s.zones.forEach((z) => walk(z.slides)); });
    Object.values(manifest.playlists).forEach((p) => walk(p.slides));
    const have = new Set(await mediaDb.keys());
    for (const k of have) if (!wanted.has(k)) await mediaDb.del(k);
    for (const k of have) if (wanted.has(k) && !brokenCopies.has(k)) cachedUrls.add(k);
    for (const url of wanted) {
      if (have.has(url)) continue;
      try {
        const res = await fetch(url);
        if (res.ok) { await mediaDb.put(url, await res.blob()); cachedUrls.add(url); }
      } catch { /* retried on the next sync */ }
    }
    state.offlineReady = [...wanted].every((u) => cachedUrls.has(u));
  } catch (e) {
    console.warn('Media cache unavailable', e);
  } finally { caching = false; }
}

// Prefer the local copy, which saves bandwidth and is the only copy when offline.
async function localUrl(url) {
  if (!cachedUrls.has(url)) return { src: url, release() {} };
  try {
    const blob = await mediaDb.get(url);
    if (blob) {
      const src = URL.createObjectURL(blob);
      return { src, release: () => URL.revokeObjectURL(src) };
    }
  } catch { /* fall through to network */ }
  return { src: url, release() {} };
}

// Some browsers, notably on iPhones, can store a file but fail to display the saved copy, or never
// report back at all. When that happens, fall back to the server's copy.
async function loadMedia(url, load) {
  const local = await localUrl(url);
  if (local.src === url) { await load(url); return local; }
  try {
    await Promise.race([load(local.src), sleep(8000).then(() => { throw new Error('timed out'); })]);
    return local;
  } catch (e) {
    console.warn('Saved copy failed, using the server', url, e.message);
    local.release();
    cachedUrls.delete(url);
    brokenCopies.add(url);
    await load(url);
    return { src: url, release() {} };
  }
}

// Browsers refuse sound until someone taps the screen or presses a remote button. Videos that should have
// sound play muted until then, so they don't stall, and come back on with the first press.
const SOUND_HINT = 'For sound, tap the screen or press OK on the remote';
const waitingForSound = new Set();
let soundHint;
function wantSound(video) {
  waitingForSound.add(video);
  if (soundHint || isPreview) return;
  soundHint = el('div', 'sound-hint', SOUND_HINT);
  stage.append(soundHint);
}
function forgetSound(video) {
  waitingForSound.delete(video);
  if (!waitingForSound.size) { soundHint?.remove(); soundHint = null; }
}
const turnSoundOn = () => {
  for (const video of [...waitingForSound]) { video.muted = false; forgetSound(video); }
};
document.addEventListener('pointerdown', turnSoundOn);
document.addEventListener('keydown', turnSoundOn);

// ---------- renderers ----------
let hlsLoading;
const loadHls = () => (hlsLoading ||= new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = '/vendor/hls.min.js'; s.onload = res; s.onerror = rej;
  document.head.append(s);
}));

/** Builds a slide's DOM. Returns { node, ready, start(onEnd), stop() }. */
function mount(slide) {
  const node = el('div', 'layer');
  let cleanup = () => {};
  let ready = Promise.resolve();
  let start = () => {};

  switch (slide.type) {
    case 'image': {
      const img = el('img', `fit-${slide.fit || 'contain'}`);
      img.alt = '';
      ready = (async () => {
        const local = await loadMedia(slide.url, (src) => new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('The picture could not be loaded')); img.src = src; }));
        cleanup = local.release;
      })();
      node.append(img);
      break;
    }
    case 'video': {
      const v = el('video', `fit-${slide.fit || 'contain'}`);
      v.playsInline = true; v.preload = 'auto'; v.muted = slide.muted !== false;
      v.setAttribute('playsinline', ''); // iPhones can hold back loadeddata until playback, but do report metadata
      ready = (async () => {
        let release = () => {};
        cleanup = () => { forgetSound(v); v.pause(); v.removeAttribute('src'); v.load(); release(); };
        const local = await loadMedia(slide.url, (src) => new Promise((res, rej) => { v.onloadeddata = res; v.onloadedmetadata = res; v.onerror = () => rej(new Error('This device cannot play this video')); v.src = src; }));
        release = local.release;
      })();
      start = (onEnd) => {
        v.onended = slide.duration > 0 ? () => { v.currentTime = 0; v.play().catch(() => {}); } : onEnd;
        // Browsers can refuse sound without a user gesture; retry muted rather than stall.
        v.play().catch(() => { v.muted = true; wantSound(v); v.play().catch(onEnd); });
      };
      node.append(v);
      break;
    }
    case 'url': {
      const f = el('iframe');
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.src = slide.url;
      if (slide.refresh > 0) {
        const t = setInterval(() => { f.src = slide.url; }, slide.refresh * 1000);
        cleanup = () => clearInterval(t);
      }
      ready = new Promise((res) => { f.onload = res; setTimeout(res, 6000); });
      node.append(f);
      break;
    }
    case 'youtube': {
      const f = el('iframe');
      const q = new URLSearchParams({ autoplay: 1, mute: slide.muted !== false ? 1 : 0, controls: 0, loop: 1, playlist: slide.videoId, rel: 0, modestbranding: 1, playsinline: 1 });
      f.allow = 'autoplay; encrypted-media';
      f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(slide.videoId)}?${q}`;
      ready = new Promise((res) => { f.onload = res; setTimeout(res, 6000); });
      node.append(f);
      break;
    }
    case 'html': {
      const f = el('iframe');
      // Opaque origin: scripts run but cannot reach the player's storage or device key.
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = slide.html;
      ready = new Promise((res) => { f.onload = res; setTimeout(res, 3000); });
      node.append(f);
      break;
    }
    case 'text':
      node.append(textSlide(slide.text));
      break;
    case 'stream': {
      if (slide.kind === 'mjpeg') {
        const img = el('img', 'fit-contain');
        img.src = slide.url;
        cleanup = () => img.removeAttribute('src');
        node.append(img);
      } else {
        const v = el('video', 'fit-contain');
        v.playsInline = true; v.muted = slide.muted !== false; v.autoplay = true;
        node.append(v);
        let hls;
        ready = (async () => {
          // hls.js first: some Chromium builds claim native HLS but fail on live playlists.
          // Native playback is for iOS, which has no Media Source support.
          if (!window.MediaSource) { v.src = slide.url; return; }
          await loadHls();
          hls = new window.Hls({ liveDurationInfinity: true, lowLatencyMode: true });
          hls.on(window.Hls.Events.ERROR, (_e, d) => { if (d.fatal) setTimeout(() => hls?.startLoad(), 3000); });
          hls.loadSource(slide.url);
          hls.attachMedia(v);
        })();
        cleanup = () => { hls?.destroy(); hls = null; v.removeAttribute('src'); v.load(); };
        start = () => v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      }
      break;
    }
    case 'composition': {
      const comp = el('div', 'comp');
      comp.style.background = slide.bg || '#000';
      const seqs = [];
      [...slide.zones].sort((a, b) => a.z - b.z).forEach((z) => {
        const zone = el('div', 'zone');
        Object.assign(zone.style, { left: `${z.x}%`, top: `${z.y}%`, width: `${z.w}%`, height: `${z.h}%`, zIndex: z.z });
        comp.append(zone);
        const s = new Sequencer(zone, () => z.slides, { transition: { effect: 'fade', speed: 'fast' } });
        seqs.push(s);
      });
      start = () => seqs.forEach((s) => s.play());
      cleanup = () => seqs.forEach((s) => s.stop());
      node.append(comp);
      break;
    }
    default: // plugin content
      if (slide.url) {
        const f = el('iframe');
        f.setAttribute('sandbox', 'allow-scripts');
        f.src = slide.url;
        ready = new Promise((res) => { f.onload = res; setTimeout(res, 6000); });
        node.append(f);
      }
  }
  return { node, ready, start, stop: () => cleanup() };
}

const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;
function textSlide(c = {}) {
  const box = el('div', 'text-slide');
  box.style.background = SAFE_COLOR.test(c.bg || '') ? c.bg : '#000';
  const inner = el('div', 'inner', c.text || '');
  const scale = Number(c.size) || 6;
  Object.assign(inner.style, {
    color: SAFE_COLOR.test(c.color || '') ? c.color : '#fff',
    fontSize: `${scale}cqw`,
    lineHeight: 1.15,
    fontWeight: c.bold ? 700 : 400,
    fontStyle: c.italic ? 'italic' : 'normal',
    textDecoration: c.underline ? 'underline' : 'none',
    textAlign: c.align || 'center',
    fontFamily: c.font === 'display' ? "'Bricolage', system-ui, sans-serif" : c.font === 'mono' ? 'ui-monospace, monospace' : "'Instrument', system-ui, sans-serif",
    padding: `${Number(c.margin) || 0}cqw`,
  });
  if (c.single) box.classList.add('single');
  if (c.scroll) {
    box.classList.add('scroll', c.direction === 'right' ? 'dir-right' : 'dir-left');
    // Speed is roughly screen widths per minute, so longer text takes proportionally longer.
    const speed = Math.max(Number(c.speed) || 5, 1);
    const seconds = Math.max(4, (60 / speed) * (1 + (String(c.text || '').length * scale * 0.5) / 100));
    inner.style.setProperty('--scroll', `${seconds}s`);
  }
  box.append(inner);
  return box;
}

// ---------- sequencer: plays a slide list with transitions; used for the screen and each zone ----------
class Sequencer {
  constructor(container, getSlides, opts = {}) {
    Object.assign(this, { container, getSlides, opts });
    this.seq = el('div', 'seq');
    container.append(this.seq);
    this.running = false;
    this.index = -1;
    this.current = null;
    this.cycles = 0;
    this.lastId = null;
  }

  play() {
    if (this.running) return;
    this.running = true;
    this.run();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.wake?.();
    this.current?.stop();
    this.current = null;
    this.seq.replaceChildren();
    this.seq.remove();
  }

  eligible(slides, now) {
    return slides.filter((s) => allActive(s.schedules, now) && !(state.offline && s.network));
  }

  next() {
    const slides = this.getSlides() || [];
    const list = this.eligible(slides, new Date());
    if (!list.length) return null;
    // Continue from where the last slide sits in the current list, even if it was edited meanwhile.
    const at = list.findIndex((s) => s.id === this.lastId);
    const i = at < 0 ? 0 : (at + 1) % list.length;
    if (at >= 0 && i === 0) this.cycles++;
    return list[i];
  }

  // Resolves early if the sequencer is kicked (new content) or stopped.
  wait(ms) {
    return new Promise((res) => {
      this.wake = res;
      this.timer = setTimeout(res, ms);
    });
  }

  async run() {
    while (this.running) {
      const loopLimit = this.opts.loop?.() || 0;
      const slide = this.next();
      if (loopLimit && this.cycles >= loopLimit) { await this.wait(5000); continue; }
      if (!slide) {
        this.clear();
        this.opts.onIdle?.();
        await this.wait(3000);
        continue;
      }
      // Sole item in the list and unchanged: keep it on screen rather than reloading it.
      const sig = JSON.stringify(slide);
      if (sig === this.lastSig && this.current && slide.type !== 'video') {
        await this.wait(Math.max((slide.duration || 0) * 1000, 3000));
        continue;
      }
      this.lastSig = sig;
      this.lastId = slide.id;
      const m = mount(slide);
      try {
        await Promise.race([m.ready, sleep(30000).then(() => { throw new Error('It took too long to load'); })]);
      } catch (e) {
        m.ready.catch(() => {}); // it may still fail after the time limit
        console.warn('Skipping slide', slide.name, e.message);
        m.stop();
        this.opts.onError?.(slide, e);
        await this.wait(1500);
        continue;
      }
      if (!this.running) { m.stop(); return; }
      this.show(m);
      const started = Date.now();
      this.opts.onPlay?.(slide);
      await new Promise((res) => {
        let done = false;
        const end = () => { if (!done) { done = true; res(); } };
        this.wake = end;
        m.start(end);
        // A duration of 0 means "until it finishes"; only videos have a natural end.
        const natural = slide.type === 'video' && !(slide.duration > 0);
        const ms = natural ? 6 * 3600e3 : (slide.duration > 0 ? slide.duration * 1000 : 10000);
        this.timer = setTimeout(end, ms);
      });
      clearTimeout(this.timer);
      this.opts.onDone?.(slide, (Date.now() - started) / 1000);
    }
  }

  transition() {
    const t = { ...state.transition, ...(this.opts.transition || {}) };
    if (this.opts.getTransition) Object.assign(t, this.opts.getTransition());
    return t;
  }

  show(m) {
    const { effect = 'fade', speed = 'normal', direction = 'left' } = this.transition();
    const secs = SPEEDS[speed] ?? SPEEDS.normal;
    const [dx, dy] = DIRS[direction] || DIRS.left;
    const prev = this.current;
    const node = m.node;
    this.current = m;
    const animate = effect !== 'none' && prev && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate) {
      this.seq.append(node);
      prev?.node.remove();
      prev?.stop();
      return;
    }
    const fx = `fx-${effect}`;
    this.seq.style.setProperty('--t', `${secs}s`);
    this.seq.style.setProperty('--dx', dx);
    this.seq.style.setProperty('--dy', dy);
    node.classList.add(fx, 'enter', 'from');
    prev.node.classList.add(fx, 'leave');
    this.seq.append(node);
    node.getBoundingClientRect(); // commit the start state before transitioning
    requestAnimationFrame(() => {
      node.classList.remove('from');
      prev.node.classList.add('to');
    });
    setTimeout(() => {
      prev.node.remove();
      prev.stop();
      node.classList.remove(fx, 'enter');
    }, secs * 1000 + 80);
  }

  clear() {
    this.current?.node.remove();
    this.current?.stop();
    this.current = null;
    this.lastId = null;
    this.lastSig = null;
  }
}

// ---------- app state ----------
const state = {
  manifest: null, offline: false, offlineReady: false, seq: null, activeId: undefined, playEvents: store.get('events') || [],
  deviceKey: null, transition: {}, nowPlaying: null, params: {}, loopCount: 0, slideError: null, mirror: null,
};

function currentPlaylist() {
  const m = state.manifest;
  if (!m) return null;
  const { playlistId } = pickPlaylist(m.rules, m.fallback);
  return playlistId ? m.playlists[playlistId] || null : null;
}

function applyDisplay() {
  const s = state.manifest?.screenSettings || {};
  const rotate = param('rotate', s.rotation || 'normal');
  stage.className = rotate === 'normal' ? '' : `rot-${rotate}`;
  const bg = qs.get('bgcolor') ? `#${qs.get('bgcolor').replace(/[^0-9a-f]/gi, '')}` : (s.bg || '#000');
  document.documentElement.style.setProperty('--bg', param('transparent') === '1' ? 'transparent' : bg);
  document.body.classList.toggle('locked', param('interactive', '1') === '0');
  document.body.classList.toggle('no-cursor', !isPreview);
}

function updateTransition() {
  const pl = currentPlaylist();
  const m = state.manifest;
  const set = pl?.settings || {};
  const s = m?.screenSettings || {};
  state.transition = {
    effect: param('animation_effect', s.transition || set.transition || m?.defaults?.transition || 'fade'),
    speed: param('animation_speed', set.speed || 'normal'),
    direction: param('animation_direction', set.direction || 'left'),
  };
  state.loopCount = Number(param('loop', set.loop || 0)) || 0;
}

// The main sequencer reads the current playlist each step, so edits and dayparting apply at slide boundaries.
function startSequencer() {
  if (state.seq || state.mirror) return;
  state.seq = new Sequencer(stage, () => currentPlaylist()?.slides || [], {
    loop: () => state.loopCount,
    onError(slide, e) {
      state.slideError = `${slide.name}: ${e.message}`;
      showMessage(`Can't show "${slide.name}"`, e.message);
      heartbeat();
    },
    onPlay(slide) {
      if (state.slideError) { state.slideError = null; clearMessage(); }
      state.nowPlaying = slide;
      debugLine();
      heartbeat();
    },
    onDone(slide, seconds) {
      if (!state.deviceKey) return;
      state.playEvents.push({ contentId: slide.contentId, name: slide.name, playlistId: currentPlaylist()?.id, at: new Date(Date.now() - seconds * 1000).toISOString(), seconds: Math.round(seconds) });
      if (state.playEvents.length > 5000) state.playEvents.splice(0, state.playEvents.length - 5000);
      store.set('events', state.playEvents);
    },
    onIdle() { state.nowPlaying = null; },
  });
  state.seq.play();
}

function applyManifest(m, fresh) {
  if (m.version === state.manifest?.version && !fresh) return;
  state.manifest = m;
  updateTransition();
  applyDisplay();
  renderBroadcasts();
  document.title = m.screen?.name || m.brand?.name || 'Vitrine Player';
  injectSnippet(m.snippet);
  syncMediaCache(m);
  startSequencer();
}

let snippetDone = '';
function injectSnippet(code) {
  if (!code || snippetDone === code || isPreview) return;
  snippetDone = code;
  const range = document.createRange();
  document.head.append(range.createContextualFragment(code));
}

// ---------- broadcasts ----------
let bcNode = null;
function renderBroadcasts() {
  const list = (state.manifest?.broadcasts || []).filter((b) => broadcastActive(b));
  // Full-screen beats a banner, then the newest wins. One at a time stays legible from across a room.
  const b = list.find((x) => x.layout === 'full') || list[0];
  const sig = b ? `${b.id}:${b.message}` : '';
  if (bcNode?.dataset.sig === sig) return;
  bcNode?.remove();
  bcNode = null;
  if (!b) return;
  const n = el('div', `bc bc-${b.style} bc-${b.layout}`);
  n.dataset.sig = sig;
  if (b.layout === 'full') {
    if (b.title) n.append(el('h1', '', b.title));
    n.append(el('p', '', b.message));
  } else {
    if (b.title) n.append(el('b', '', b.title));
    n.append(el('span', '', b.message));
  }
  stage.append(n);
  bcNode = n;
}

// ---------- server link ----------
function manifestUrl() {
  if (route === 'tv') return '/player-api/manifest';
  if (route === 'use') return `/player-api/manifest?playlist=${encodeURIComponent(path[1])}`;
  if (route === 'group') return `/player-api/manifest?group=${encodeURIComponent(path[1])}`;
  return `/player-api/manifest?${qs}`;
}
const storeKey = () => `manifest.${route}.${path[1] || ''}`;

async function fetchManifest() {
  const headers = state.deviceKey ? { 'x-device-key': state.deviceKey } : {};
  try {
    const res = await fetch(manifestUrl(), { headers, cache: 'no-store' });
    if (res.status === 404 && state.deviceKey) { unpair(); return; }
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      if (!state.manifest) showMessage(res.status === 403 || res.status === 401 ? 'This player link is not available' : 'Nothing to play', error || '');
      return;
    }
    const m = await res.json();
    setOffline(false);
    if (!isPreview) store.set(storeKey(), m);
    clearMessage();
    applyManifest(m);
    // Without this, a screen that just connected is black and looks broken. A "screen off" rule stays black.
    if (route === 'tv' && !m.fallback && !m.rules?.length) showMessage(`${m.screen?.name || 'This screen'} is connected`, 'Choose a playlist for it in Vitrine on your computer.');
  } catch {
    setOffline(true);
    if (!state.manifest) {
      const saved = store.get(storeKey());
      if (saved) {
        const keys = await mediaDb.keys().catch(() => []);
        keys.forEach((k) => cachedUrls.add(k));
        applyManifest(saved, true);
      } else showMessage('Waiting for the studio', 'This screen will start as soon as the server can be reached.');
    }
  }
}

function setOffline(v) {
  if (state.offline === v) return;
  state.offline = v;
  document.body.classList.toggle('offline', v);
}

let source;
function connectEvents() {
  const url = state.deviceKey ? `/player-api/events?key=${encodeURIComponent(state.deviceKey)}` : '/player-api/events';
  source = new EventSource(url);
  source.onopen = () => { checkMirror(); if (state.offline) { fetchManifest(); heartbeat(); } };
  source.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'refresh') fetchManifest();
    if (msg.type === 'reload') location.reload();
    if (msg.type === 'identify') identify(msg.name);
    if (msg.type === 'unpaired') unpair();
    if (msg.type === 'mirror') startMirror(msg.id, msg.audio);
    if (msg.type === 'mirror-stop') stopMirror();
  };
}

// ---------- mirroring: shows a computer's screen in place of the playlist ----------
async function checkMirror() {
  if (!state.deviceKey) return;
  try {
    const r = await (await fetch('/player-api/mirror', { headers: { 'x-device-key': state.deviceKey }, cache: 'no-store' })).json();
    if (r.id) startMirror(r.id, r.audio); else stopMirror();
  } catch { /* checked again when the connection returns */ }
}

const MIRROR_SAMPLE_RATE = 24000;

// Plays the computer's sound as it arrives. Browsers keep audio off until someone taps the screen or
// presses a remote button, so a paused context asks for that.
function startMirrorAudio(id, node) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return () => {};
  const context = new AudioCtx();
  const hint = el('div', 'sound-hint', SOUND_HINT);
  const wake = () => { context.resume().catch(() => {}); };
  const showHint = () => { if (context.state === 'running') hint.remove(); else node.append(hint); };
  context.onstatechange = showHint;
  showHint();
  wake();
  document.addEventListener('pointerdown', wake);
  document.addEventListener('keydown', wake);

  const aborter = new AbortController();
  let nextStart = 0;
  const play = (bytes) => {
    if (context.state !== 'running') return; // don't let sound pile up until it's on
    // Browsers can hold back the start of a stream and release it in one go. Only the newest sound matches the picture.
    const all = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const samples = all.length > MIRROR_SAMPLE_RATE ? all.subarray(all.length - MIRROR_SAMPLE_RATE / 5) : all;
    const buffer = context.createBuffer(1, samples.length, MIRROR_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    // Restart after a gap, and drop audio that has fallen too far behind the picture.
    const now = context.currentTime;
    if (nextStart < now) nextStart = now + 0.2;
    if (nextStart > now + 1) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(nextStart);
    nextStart += buffer.duration;
  };
  (async () => {
    const res = await fetch(`/player-api/mirror/${encodeURIComponent(id)}/audio?key=${encodeURIComponent(state.deviceKey)}`, { signal: aborter.signal, cache: 'no-store' });
    const reader = res.body.getReader();
    let odd = null; // network chunks can split a two-byte sample
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      let bytes = value;
      if (odd !== null) { bytes = new Uint8Array(value.length + 1); bytes[0] = odd; bytes.set(value, 1); odd = null; }
      if (bytes.length % 2) { odd = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1); }
      if (bytes.length) play(bytes.slice());
    }
  })().catch(() => {});
  return () => {
    aborter.abort();
    document.removeEventListener('pointerdown', wake);
    document.removeEventListener('keydown', wake);
    context.close().catch(() => {});
  };
}

function startMirror(id, audio) {
  if (state.mirror?.id === id) return;
  state.mirror?.stopAudio();
  state.mirror?.node.remove();
  // Stop the playlist so its video and sound don't carry on underneath.
  state.seq?.stop();
  state.seq = null;
  state.nowPlaying = { name: 'Screen mirroring' };
  clearMessage();
  const node = el('div', 'mirror');
  const img = el('img');
  img.alt = '';
  img.src = `/player-api/mirror/${encodeURIComponent(id)}/stream?key=${encodeURIComponent(state.deviceKey)}`;
  node.append(img);
  stage.append(node);
  state.mirror = { id, node, stopAudio: audio ? startMirrorAudio(id, node) : () => {} };
  heartbeat();
}

function stopMirror() {
  if (!state.mirror) return;
  state.mirror.stopAudio();
  state.mirror.node.querySelector('img').removeAttribute('src');
  state.mirror.node.remove();
  state.mirror = null;
  state.nowPlaying = null;
  startSequencer();
}

function identify(name) {
  const n = el('div', 'identify', name || 'This screen');
  stage.append(n);
  setTimeout(() => n.remove(), 8000);
}

async function heartbeat() {
  if (!state.deviceKey || isPreview) return;
  const events = state.playEvents;
  state.playEvents = [];
  try {
    const res = await fetch('/player-api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-key': state.deviceKey },
      body: JSON.stringify({
        resolution: `${screen.width}x${screen.height}`,
        nowPlaying: state.nowPlaying?.name, nowPlayingId: state.nowPlaying?.contentId,
        offlineReady: state.offlineReady, events, error: state.slideError,
      }),
    });
    if (!res.ok) throw new Error(res.status);
    store.set('events', state.playEvents);
  } catch {
    state.playEvents = [...events, ...state.playEvents]; // keep them for the next attempt
    store.set('events', state.playEvents);
  }
}

function debugLine() {
  if (param('debug') !== '1') return;
  let d = document.querySelector('.debug');
  if (!d) { d = el('div', 'debug'); document.body.append(d); }
  d.textContent = `playlist: ${currentPlaylist()?.name}\nslide: ${state.nowPlaying?.name}\nmanifest: ${state.manifest?.version}\noffline: ${state.offline}\ncached: ${cachedUrls.size}`;
}

// ---------- screens that aren't playing ----------
let messageNode;
function showMessage(title, body) {
  clearMessage();
  messageNode = el('div', 'card');
  const mark = el('div', 'mark');
  mark.append(el('i'), document.createTextNode('Vitrine'));
  messageNode.append(mark, el('h1', '', title));
  if (body) messageNode.append(el('p', '', body));
  stage.append(messageNode);
}
function clearMessage() { messageNode?.remove(); messageNode = null; }

function showPairing(code, listed) {
  clearMessage();
  messageNode = el('div', 'card');
  const mark = el('div', 'mark');
  mark.append(el('i'), document.createTextNode('Vitrine'));
  const codeEl = el('div', 'code');
  [...code].forEach((c) => codeEl.append(el('span', '', c)));
  messageNode.append(mark, el('h1', '', 'Connect this screen'), codeEl,
    el('p', '', listed
      ? 'On the computer running Vitrine, open Screens and choose Add a screen. This screen appears there with this code. Click Connect.'
      : `In the studio, open Screens, choose Add a screen, and enter this code. Studio address: ${location.origin}`));
  stage.append(messageNode);
}

function unpair() {
  localStorage.removeItem('vt.deviceKey');
  localStorage.removeItem(`vt.${storeKey()}`);
  location.reload();
}

function newKey() {
  const a = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

async function pairingLoop() {
  let key = store.get('deviceKey');
  if (!key) { key = newKey(); store.set('deviceKey', key); }
  // From a scanned QR code. Out of the address bar at once, so reloads and bookmarks don't carry it.
  let invite = param('invite');
  if (invite) history.replaceState(null, '', location.pathname);
  for (;;) {
    try {
      const res = await fetch('/player-api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, invite }) });
      const r = await res.json();
      invite = null;
      if (r.paired) { clearMessage(); return key; }
      if (r.code) showPairing(r.code, r.listed);
    } catch {
      // A paired device can run from its saved manifest; an unpaired one can only wait.
      if (store.get(storeKey())) return key;
      showMessage('Waiting for the studio', 'This screen will show a pairing code as soon as the server can be reached.');
    }
    await sleep(3000);
  }
}

function splash(brand) {
  if (param('intro', '1') === '0' || isPreview || brand === null) return Promise.resolve();
  const n = el('div', 'card splash');
  const mark = el('div', 'mark');
  mark.append(el('i'), document.createTextNode(brand || 'Vitrine'));
  n.append(mark);
  stage.append(n);
  return sleep(1500).then(() => {
    n.classList.add('gone');
    setTimeout(() => n.remove(), 700);
  });
}

// ---------- boot ----------
async function boot() {
  applyDisplay();
  // Browsers only allow full screen after a tap, which phones and tablets need to hide their address bar.
  if (!isPreview) document.addEventListener('pointerdown', () => document.documentElement.requestFullscreen?.().catch(() => {}), { once: true });
  if (!isPreview && window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/player-sw.js').catch(() => {});
  }
  if (route === 'tv') state.deviceKey = await pairingLoop();
  const introDone = splash();
  await fetchManifest();
  await introDone;
  connectEvents();
  if (state.deviceKey) heartbeat();
  setInterval(heartbeat, 30000);
  setInterval(() => { fetchManifest(); }, 60000); // backstop for missed pushes
  setInterval(() => { updateTransition(); renderBroadcasts(); debugLine(); }, 5000);
}
boot();
