// Drag-and-resize layout editor. Zone geometry is stored as percentages so a composition fits any screen.
import { h, btn, iconBtn, field, select, safely } from '../ui.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

const PRESETS = () => [
  [t('Full'), [[0, 0, 100, 100]]],
  [t('Split'), [[0, 0, 50, 100], [50, 0, 50, 100]]],
  [t('Main + side'), [[0, 0, 72, 100], [72, 0, 28, 100]]],
  [t('L-bar'), [[0, 0, 75, 85], [75, 0, 25, 85], [0, 85, 100, 15]]],
  [t('Main + ticker'), [[0, 0, 100, 88], [0, 88, 100, 12]]],
  [t('Quad'), [[0, 0, 50, 50], [50, 0, 50, 50], [0, 50, 50, 50], [50, 50, 50, 50]]],
];
const COLORS = ['#c8401a', '#14795a', '#2b5c9e', '#8a6000', '#7a3e8e', '#2f6f7e'];
const snap = (v) => Math.round(v * 2) / 2;

export function compositionEditor(cfg) {
  cfg.zones ||= [{ x: 0, y: 0, w: 100, h: 100, z: 0, contentId: null, playlistId: null, duration: 0 }];
  cfg.bg ||= '#000000';
  let current = 0;
  let content = [], playlists = [];

  const canvas = h('div', { class: 'comp-canvas' });
  const side = h('div', { class: 'stack' });

  const label = (z) => {
    if (z.playlistId) return playlists.find((p) => p.id === z.playlistId)?.name || t('Playlist');
    if (z.contentId) return content.find((c) => c.id === z.contentId)?.name || t('Item');
    return t('Empty');
  };

  function drawCanvas() {
    canvas.style.backgroundColor = cfg.bg;
    canvas.replaceChildren(...cfg.zones.map((z, i) => {
      const c = z.contentId ? content.find((x) => x.id === z.contentId) : null;
      const box = h('div', {
        class: `zone-box ${i === current ? 'on' : ''}`,
        style: { left: `${z.x}%`, top: `${z.y}%`, width: `${z.w}%`, height: `${z.h}%`, zIndex: z.z, '--zone': COLORS[i % COLORS.length] },
        onpointerdown: (e) => startDrag(e, i, 'move'),
      },
      c?.thumb && h('img', { src: c.thumb, alt: '' }),
      h('span', {}, `${i + 1}. ${label(z)}`),
      h('div', { class: 'zone-handle', onpointerdown: (e) => { e.stopPropagation(); startDrag(e, i, 'size'); } }));
      box.style.setProperty('--zone', COLORS[i % COLORS.length]);
      return box;
    }));
  }

  function startDrag(e, i, mode) {
    e.preventDefault();
    if (current !== i) { current = i; drawCanvas(); drawSide(); }
    const rect = canvas.getBoundingClientRect();
    const z = cfg.zones[i];
    const s = { x: e.clientX, y: e.clientY, zx: z.x, zy: z.y, zw: z.w, zh: z.h };
    const node = canvas.children[i];
    const move = (m) => {
      const dx = ((m.clientX - s.x) / rect.width) * 100;
      const dy = ((m.clientY - s.y) / rect.height) * 100;
      if (mode === 'move') {
        z.x = snap(Math.min(100 - z.w, Math.max(0, s.zx + dx)));
        z.y = snap(Math.min(100 - z.h, Math.max(0, s.zy + dy)));
      } else {
        z.w = snap(Math.min(100 - z.x, Math.max(5, s.zw + dx)));
        z.h = snap(Math.min(100 - z.y, Math.max(5, s.zh + dy)));
      }
      Object.assign(node.style, { left: `${z.x}%`, top: `${z.y}%`, width: `${z.w}%`, height: `${z.h}%` });
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      drawSide();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  function drawSide() {
    const z = cfg.zones[current];
    const nodes = [];
    if (z) {
      const num = (key, labelText) => field(labelText, h('input', {
        type: 'number', min: 0, max: 100, step: 0.5, value: z[key],
        onchange: (e) => { z[key] = Math.min(100, Math.max(0, Number(e.target.value) || 0)); drawCanvas(); },
      }));
      const value = z.playlistId ? `p:${z.playlistId}` : z.contentId ? `c:${z.contentId}` : '';
      nodes.push(
        h('div', { class: 'row between' }, h('b', {}, t('Zone {n}', { n: current + 1 })), iconBtn('trash', t('Remove zone'), () => {
          cfg.zones.splice(current, 1);
          current = Math.max(0, current - 1);
          drawCanvas(); drawSide();
        })),
        field(t('Shows'), select([
          ['', t('Empty')],
          ...playlists.map((p) => [`p:${p.id}`, `▶ ${p.name}`]),
          ...content.filter((c) => c.type !== 'composition').map((c) => [`c:${c.id}`, c.name]),
        ], value, (v) => {
          z.playlistId = v.startsWith('p:') ? v.slice(2) : null;
          z.contentId = v.startsWith('c:') ? v.slice(2) : null;
          drawCanvas();
        }), t('Choose a playlist to rotate items inside this zone.')),
        h('div', { class: 'grid2' }, num('x', 'X %'), num('y', 'Y %'), num('w', t('Width %')), num('h', t('Height %'))),
        field(t('Stacking order'), h('input', { type: 'number', value: z.z, onchange: (e) => { z.z = Number(e.target.value) || 0; drawCanvas(); } }), t('Higher numbers sit on top.')));
    }
    side.replaceChildren(...nodes);
  }

  const root = h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, t('Layouts')),
      PRESETS().map(([name, zones]) => btn(name, () => {
        // Keep assignments where zones line up, so trying a layout doesn't lose work.
        cfg.zones = zones.map(([x, y, w, hh], i) => ({ ...(cfg.zones[i] || { contentId: null, playlistId: null, duration: 0, z: 0 }), x, y, w, h: hh }));
        current = 0;
        drawCanvas(); drawSide();
      }, 'sm')),
      btn(t('Add zone'), () => {
        cfg.zones.push({ x: 30, y: 30, w: 40, h: 40, z: cfg.zones.length, contentId: null, playlistId: null, duration: 0 });
        current = cfg.zones.length - 1;
        drawCanvas(); drawSide();
      }, 'sm', 'plus')),
    h('div', { class: 'comp-wrap' }, canvas, h('div', { class: 'stack' }, side,
      field(t('Background'), h('input', { type: 'color', value: cfg.bg, oninput: (e) => { cfg.bg = e.target.value; drawCanvas(); } })))));

  safely(async () => {
    [content, playlists] = await Promise.all([api.get('/content'), api.get('/playlists')]);
    drawCanvas(); drawSide();
  })();
  drawCanvas(); drawSide();
  return root;
}
