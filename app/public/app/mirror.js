// Mirrors this computer's screen as a stream of JPEG pictures plus raw audio samples. That's less
// smooth than a video call, but works in every browser that can show an image, including older TVs.
import { h, btn, modal, toast, safely, check } from './ui.js';
import { api } from './api.js';
import { t } from './i18n.js';

const FRAMES_PER_SECOND = 8;
const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.7;
const AUDIO_SAMPLE_RATE = 24000;
const AUDIO_CHUNK_SAMPLES = AUDIO_SAMPLE_RATE / 5;

// Runs on the audio thread, so sound keeps flowing while the studio tab is hidden.
const AUDIO_WORKLET = `registerProcessor('mirror-capture', class extends AudioWorkletProcessor {
  process([input]) {
    if (input[0]) this.port.postMessage(input[0].slice());
    return true;
  }
});`;

async function captureAudio(track, id) {
  const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  const url = URL.createObjectURL(new Blob([AUDIO_WORKLET], { type: 'text/javascript' }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const capture = new AudioWorkletNode(context, 'mirror-capture');
  const silent = context.createGain();
  silent.gain.value = 0; // the graph must reach the output to run, but this computer already plays its own sound
  context.createMediaStreamSource(new MediaStream([track])).connect(capture);
  capture.connect(silent);
  silent.connect(context.destination);

  let chunk = new Int16Array(AUDIO_CHUNK_SAMPLES);
  let filled = 0;
  capture.port.onmessage = ({ data }) => {
    for (const sample of data) {
      chunk[filled++] = Math.max(-1, Math.min(1, sample)) * 32767;
      if (filled < chunk.length) continue;
      fetch(`/api/mirror/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk.buffer }).catch(() => {});
      chunk = new Int16Array(AUDIO_CHUNK_SAMPLES);
      filled = 0;
    }
  };
  await context.resume();
  return () => context.close();
}

let active = null;

// Timers in a hidden tab slow to a crawl, and the studio is hidden whenever someone mirrors another
// window. A worker's timer isn't slowed.
const steadyTimer = (ms, fn) => {
  const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = fn;
  URL.revokeObjectURL(url);
  return () => worker.terminate();
};

async function stopMirroring() {
  if (!active) return;
  const { id, stream, stopTimer, stopAudio, bar } = active;
  active = null;
  stopTimer();
  stopAudio?.();
  stream.getTracks().forEach((track) => track.stop());
  bar.remove();
  await api.del(`/mirror/${id}`).catch(() => {}); // already ended on the server
}

async function startMirroring(screens) {
  await stopMirroring();
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FRAMES_PER_SECOND }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, systemAudio: 'include' });
  const audioTrack = stream.getAudioTracks()[0];
  let id;
  try {
    ({ id } = await api.post('/mirror', { screenIds: screens.map((s) => s.id), audio: Boolean(audioTrack) }));
  } catch (e) {
    stream.getTracks().forEach((track) => track.stop());
    throw e;
  }

  const video = h('video', { muted: true, playsinline: true });
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  const canvas = h('canvas');
  const context = canvas.getContext('2d');
  let sending = false;
  const sendFrame = async () => {
    if (sending || !video.videoWidth) return;
    sending = true;
    try {
      const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = await new Promise((res) => { canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY); });
      const r = await fetch(`/api/mirror/${id}/frame`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: frame });
      if (r.status === 404 || r.status === 401) { await stopMirroring(); toast(t('Mirroring has ended'), true); }
    } catch { /* a dropped frame; the next one follows straight away */ }
    sending = false;
  };

  const bar = h('div', { class: 'mirror-bar', role: 'status' },
    h('span', { class: 'dot on' }),
    h('span', { class: 'clip' }, t('Mirroring to {names}', { names: screens.map((s) => s.name).join(', ') })),
    btn(t('Stop'), safely(stopMirroring), 'sm danger'));
  document.body.append(bar);
  active = { id, stream, bar, stopTimer: steadyTimer(1000 / FRAMES_PER_SECOND, sendFrame) };
  if (audioTrack) active.stopAudio = await captureAudio(audioTrack, id).catch(() => { toast(t('The sound could not be shared.'), true); });
  else toast(t('No sound is being shared. To include it, stop, then share your entire screen with system audio turned on.'), true);
  // Also covers the browser's own "Stop sharing" button.
  stream.getVideoTracks()[0].addEventListener('ended', () => stopMirroring());
}

/** Lets the user choose screens, then asks the browser which window or screen to share. */
export function mirrorDialog(screens, preselected = []) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    modal({
      title: t('Mirror this computer'),
      body: h('p', { style: { margin: 0 } }, t('Mirroring only works from the Windows computer running Vitrine. Open Vitrine there and try again. To mirror a phone, use AirPlay or the casting built into your phone and TV.')),
      foot: (close) => [btn(t('Close'), close, 'primary')],
    });
    return;
  }
  const chosen = new Set(preselected.length ? preselected : screens.filter((s) => s.online).map((s) => s.id));
  modal({
    title: t('Mirror this computer'),
    body: [
      h('p', { class: 'small muted', style: { margin: 0 } }, t('Shows this computer\'s screen on the screens you choose. They go back to their playlists when you stop.')),
      h('div', { class: 'stack' }, screens.map((s) => check(s.online ? s.name : `${s.name} (${t('Offline')})`, chosen.has(s.id), (on) => { if (on) chosen.add(s.id); else chosen.delete(s.id); }))),
      h('p', { class: 'small muted', style: { margin: 0 } }, t('For sound, choose your entire screen in the next window and turn on system audio.')),
      h('p', { class: 'small muted', style: { margin: 0 } }, t('Don\'t show anything private: everyone who can see these screens will see it.')),
    ],
    foot: (close) => [btn(t('Cancel'), close), btn(t('Start mirroring'), safely(async () => {
      const picked = screens.filter((s) => chosen.has(s.id));
      if (!picked.length) { toast(t('Choose at least one screen'), true); return; }
      close();
      try {
        await startMirroring(picked);
      } catch (e) {
        // Cancelling the browser's picker is a choice, not a failure.
        if (e.name !== 'NotAllowedError') throw e;
      }
    }), 'primary')],
  });
}
