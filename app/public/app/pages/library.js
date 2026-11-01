import { h, icon, btn, iconBtn, modal, toast, safely, confirmDialog, prompt1, empty, field, select, check, contentThumb, formatBytes, formatDuration, typeLabel, TYPE_ICONS } from '../ui.js';
import { api, uploadFile } from '../api.js';
import { t } from '../i18n.js';
import { can } from '../app.js';
import { compositionEditor } from './composition.js';

let filter = { folder: 'all', type: '', q: '' };

// ---------- file handling ----------
/** Capture a poster, duration and size in the browser so the server needs no media tooling. */
function videoInfo(file) {
  return new Promise((res) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (out) => { if (!done) { done = true; URL.revokeObjectURL(url); res(out); } };
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
    v.onerror = () => finish({});
    setTimeout(() => finish({}), 10000);
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 0) / 2); };
    v.onseeked = () => {
      const c = document.createElement('canvas');
      const w = Math.min(640, v.videoWidth || 640);
      c.width = w; c.height = Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((thumb) => finish({ thumb, duration: v.duration, width: v.videoWidth, height: v.videoHeight }), 'image/jpeg', 0.8);
    };
  });
}
function imageInfo(file) {
  return new Promise((res) => {
    const i = new Image();
    const url = URL.createObjectURL(file);
    i.onload = () => { URL.revokeObjectURL(url); res({ width: i.naturalWidth, height: i.naturalHeight }); };
    i.onerror = () => { URL.revokeObjectURL(url); res({}); };
    i.src = url;
  });
}

let pdfModule;
async function pdfToImages(file, onProgress) {
  pdfModule ||= await import('/vendor/pdf.min.mjs');
  pdfModule.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  const doc = await pdfModule.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 1920 / Math.max(base.width, base.height) });
    const c = document.createElement('canvas');
    c.width = viewport.width; c.height = viewport.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    out.push(new File([blob], `Page ${n}.jpg`, { type: 'image/jpeg' }));
    onProgress?.(n / doc.numPages);
    page.cleanup();
  }
  return out;
}

const uploadTray = { el: null, items: 0 };
function trayRow(name) {
  if (!uploadTray.el) { uploadTray.el = h('div', { class: 'uploads', role: 'status' }); document.body.append(uploadTray.el); }
  uploadTray.items++;
  const bar = h('i', { style: { width: '0%' } });
  const row = h('div', { style: { marginBottom: '8px' } }, h('div', { class: 'small clip' }, name), h('div', { class: 'progress' }, bar));
  uploadTray.el.append(row);
  return {
    set: (p) => { bar.style.width = `${Math.round(p * 100)}%`; },
    done: () => {
      row.remove();
      if (--uploadTray.items === 0) { uploadTray.el.remove(); uploadTray.el = null; }
    },
  };
}

async function uploadOne(file, folderId, row) {
  const form = new FormData();
  const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
  const info = isVideo ? await videoInfo(file) : await imageInfo(file);
  if (folderId) form.append('folderId', folderId);
  for (const k of ['duration', 'width', 'height']) if (info[k]) form.append(k, info[k]);
  form.append('file', file);
  if (info.thumb) form.append('thumb', info.thumb, 'thumb.jpg');
  return uploadFile(form, row.set);
}

export async function uploadFiles(files, folderId) {
  const created = [];
  for (const file of files) {
    const row = trayRow(file.name);
    try {
      if (/\.pdf$/i.test(file.name)) {
        created.push(...await importPdf(file, folderId, row));
      } else {
        created.push(await uploadOne(file, folderId, row));
      }
    } catch (e) { toast(`${file.name}: ${e.message}`, true); }
    row.done();
  }
  if (created.length) toast(t('{n} added to the library', { n: created.length }));
  return created;
}

// Each PDF page becomes an image, grouped in a folder named after the document.
async function importPdf(file, parentId, row) {
  const pages = await pdfToImages(file, (p) => row.set(p * 0.5));
  const folder = await api.post('/folders', { name: file.name.replace(/\.pdf$/i, ''), parentId });
  const created = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const f = new FormData();
    f.append('folderId', folder.id);
    f.append('file', page);
    created.push(await uploadFile(f));
    row.set(0.5 + ((i + 1) / pages.length) * 0.5);
  }
  return created;
}

// ---------- editors ----------
const TEXT_DEFAULT = { text: '', size: 6, color: '#ffffff', bg: '#14130f', bold: true, italic: false, underline: false, align: 'center', font: 'display', scroll: false, speed: 5, direction: 'left', single: false, margin: 3 };

function textEditor(cfg) {
  const preview = h('div', { class: 'bc-preview', style: { container: 'p / size' } });
  const draw = () => {
    const inner = h('div', {
      style: {
        color: cfg.color, fontSize: `${cfg.size}cqw`, lineHeight: 1.15, fontWeight: cfg.bold ? 700 : 400, fontStyle: cfg.italic ? 'italic' : 'normal',
        textDecoration: cfg.underline ? 'underline' : 'none', textAlign: cfg.align, width: '100%', padding: `${cfg.margin}cqw`,
        whiteSpace: cfg.single || cfg.scroll ? 'nowrap' : 'pre-wrap', overflow: 'hidden', overflowWrap: 'anywhere',
        fontFamily: cfg.font === 'display' ? 'var(--display)' : cfg.font === 'mono' ? 'var(--mono)' : 'var(--body)',
      },
    }, cfg.text || t('Your message'));
    preview.replaceChildren(h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', background: cfg.bg } }, inner));
  };
  const bind = (key, conv = (v) => v) => (e) => { cfg[key] = conv(e.target.value); draw(); };
  const scrollFields = h('div', { class: 'grid2' + (cfg.scroll ? '' : ' hide') },
    field(t('Scroll speed'), h('input', { type: 'number', min: 1, max: 30, value: cfg.speed, oninput: bind('speed', Number) })),
    field(t('Direction'), select([['left', t('Left')], ['right', t('Right')]], cfg.direction, (v) => { cfg.direction = v; })));
  draw();
  return h('div', { class: 'stack' }, preview,
    field(t('Text'), h('textarea', { rows: 3, value: cfg.text, oninput: bind('text') })),
    h('div', { class: 'grid3' },
      field(t('Size'), h('input', { type: 'range', min: 1, max: 30, step: 0.5, value: cfg.size, oninput: bind('size', Number) })),
      field(t('Text color'), h('input', { type: 'color', value: cfg.color, oninput: bind('color') })),
      field(t('Background'), h('input', { type: 'color', value: cfg.bg, oninput: bind('bg') }))),
    h('div', { class: 'grid3' },
      field(t('Font'), select([['display', t('Display')], ['body', t('Clean')], ['mono', t('Monospace')]], cfg.font, (v) => { cfg.font = v; draw(); })),
      field(t('Alignment'), select([['left', t('Left')], ['center', t('Center')], ['right', t('Right')]], cfg.align, (v) => { cfg.align = v; draw(); })),
      field(t('Margin'), h('input', { type: 'range', min: 0, max: 15, value: cfg.margin, oninput: bind('margin', Number) }))),
    h('div', { class: 'row' },
      check(t('Bold'), cfg.bold, (v) => { cfg.bold = v; draw(); }),
      check(t('Italic'), cfg.italic, (v) => { cfg.italic = v; draw(); }),
      check(t('Underline'), cfg.underline, (v) => { cfg.underline = v; draw(); }),
      check(t('Single line'), cfg.single, (v) => { cfg.single = v; draw(); }),
      check(t('Scrolling'), cfg.scroll, (v) => { cfg.scroll = v; scrollFields.classList.toggle('hide', !v); draw(); })),
    scrollFields);
}

function htmlEditor(cfg) {
  cfg.html ??= '<!doctype html>\n<style>\n  body { margin: 0; height: 100vh; display: grid; place-items: center;\n         background: #14130f; color: #fff; font: 700 8vw system-ui; }\n</style>\n<h1>Hello</h1>\n';
  const frame = h('iframe', { sandbox: 'allow-scripts', title: t('Preview'), srcdoc: cfg.html });
  let timer;
  return h('div', { class: 'grid2' },
    field('HTML', h('textarea', {
      class: 'code', rows: 16, spellcheck: 'false', value: cfg.html,
      oninput: (e) => { cfg.html = e.target.value; clearTimeout(timer); timer = setTimeout(() => { frame.srcdoc = cfg.html; }, 400); },
      onkeydown: (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
        e.target.dispatchEvent(new Event('input'));
      },
    })),
    field(t('Preview'), h('div', { class: 'window' }, frame)));
}

function pluginFields(def, cfg) {
  return h('div', { class: 'stack' }, def.fields.map((f) => {
    cfg[f.key] ??= f.default;
    const on = (e) => { cfg[f.key] = f.type === 'number' ? Number(e.target.value) : e.target.value; };
    if (f.type === 'checkbox') return check(f.label, cfg[f.key], (v) => { cfg[f.key] = v; });
    if (f.type === 'select') return field(f.label, select(f.options.map((o) => [o.value, o.label]), cfg[f.key], (v) => { cfg[f.key] = v; }));
    if (f.type === 'textarea') return field(f.label, h('textarea', { value: cfg[f.key], oninput: on }));
    return field(f.label, h('input', { type: f.type || 'text', value: cfg[f.key], oninput: on }));
  }));
}

function configForm(type, cfg, meta) {
  switch (type) {
    case 'url': return h('div', { class: 'stack' },
      field(t('Page address'), h('input', { type: 'url', value: cfg.url || '', placeholder: 'https://', oninput: (e) => { cfg.url = e.target.value; } }), t('Some sites refuse to appear inside another page. Use Preview to check.')),
      field(t('Reload every (seconds)'), h('input', { type: 'number', min: 0, value: cfg.refresh || 0, oninput: (e) => { cfg.refresh = Number(e.target.value); } }), t('Leave at 0 to reload only when the slide starts.')));
    case 'youtube': return h('div', { class: 'stack' },
      field(t('YouTube link'), h('input', { type: 'url', value: cfg.url || '', placeholder: 'https://www.youtube.com/watch?v=…', oninput: (e) => { cfg.url = e.target.value; } })),
      check(t('Muted'), cfg.muted !== false, (v) => { cfg.muted = v; }));
    case 'html': return htmlEditor(cfg);
    case 'text': return textEditor(Object.assign(cfg, { ...TEXT_DEFAULT, ...cfg }));
    case 'stream': return h('div', { class: 'stack' },
      field(t('Stream address'), h('input', { value: cfg.url || '', placeholder: 'rtsp://user:pass@192.168.1.20/stream', oninput: (e) => { cfg.url = e.target.value; } }), t('RTSP and RTMP are converted by FFmpeg on the server. HLS and MJPEG play directly.')),
      field(t('Format for direct playback'), select([['hls', 'HLS (.m3u8)'], ['mjpeg', 'MJPEG']], cfg.kind || 'hls', (v) => { cfg.kind = v; })),
      check(t('Convert on the server (needed for RTSP and RTMP)'), cfg.transcode, (v) => { cfg.transcode = v; }),
      check(t('Muted'), cfg.muted !== false, (v) => { cfg.muted = v; }),
      !meta.ffmpeg && h('div', { class: 'chip warn' }, t('FFmpeg was not found on the server')));
    case 'folder': return h('div', { class: 'stack' },
      field(t('Folder on the server'), h('input', { value: cfg.path || meta.folderRoots[0] || '', oninput: (e) => { cfg.path = e.target.value; } }), `${t('Allowed locations:')} ${meta.folderRoots.join(', ')}`),
      field(t('Fit'), select([['contain', t('Fit inside')], ['cover', t('Fill and crop')]], cfg.fit || 'contain', (v) => { cfg.fit = v; })),
      check(t('Play videos to the end'), cfg.videoFull !== false, (v) => { cfg.videoFull = v; }),
      h('p', { class: 'small muted', style: { margin: 0 } }, t('New files show up on screens at the next refresh. Pictures use the slide duration.')));
    case 'composition': return compositionEditor(cfg);
    case 'image': return field(t('Fit'), select([['contain', t('Fit inside')], ['cover', t('Fill and crop')], ['fill', t('Stretch')]], cfg.fit || 'contain', (v) => { cfg.fit = v; }));
    case 'video': return h('div', { class: 'stack' },
      field(t('Fit'), select([['contain', t('Fit inside')], ['cover', t('Fill and crop')], ['fill', t('Stretch')]], cfg.fit || 'contain', (v) => { cfg.fit = v; })),
      check(t('Muted'), cfg.muted !== false, (v) => { cfg.muted = v; }),
      h('p', { class: 'small muted', style: { margin: 0 } }, t('Screens may ignore sound until someone has interacted with them. That is a browser rule.')));
    default: {
      const def = meta.plugins.find((p) => p.type === type);
      return def ? pluginFields(def, cfg) : h('p', {}, t('The plugin for this content is turned off.'));
    }
  }
}

export function openPreview(title, query) {
  const frame = h('iframe', { src: `/preview?${query}`, title, allow: 'autoplay' });
  modal({ title, wide: true, body: h('div', { class: 'window' }, frame) });
}

async function editContent(item, meta, folderId, onSaved) {
  const type = item.type;
  const cfg = structuredClone(item.config || {});
  const name = h('input', { value: item.name || '', placeholder: t('Name'), required: true });
  const tags = h('input', { value: (item.tags || []).join(', '), placeholder: t('sale, lobby, winter') });
  const pluginDef = meta.plugins.find((p) => p.type === type);
  const wide = ['html', 'composition', 'text'].includes(type);

  let usage = null;
  if (item.id) usage = await api.get(`/content/${item.id}`);

  modal({
    title: item.id ? item.name : t('New {type}', { type: pluginDef?.label || typeLabel(type) }),
    wide,
    body: () => [
      h('div', { class: 'grid2' }, field(t('Name'), name), field(t('Tags'), tags)),
      configForm(type, cfg, meta),
      usage && h('div', { class: 'small muted' }, usage.playlists.length
        ? `${t('Used in:')} ${usage.playlists.map((p) => p.name).join(', ')}`
        : t('Not used in any playlist yet.')),
      item.size > 0 && h('div', { class: 'small muted' }, [formatBytes(item.size), item.width && `${item.width}×${item.height}`, item.duration && formatDuration(item.duration)].filter(Boolean).join(' · ')),
    ],
    foot: (close) => [
      item.id && can('content') && h('div', { class: 'left' }, btn(t('Delete'), safely(async () => {
        const warn = usage?.playlists.length ? t('It will also be removed from {n} playlists.', { n: usage.playlists.length }) : t('This cannot be undone.');
        if (!await confirmDialog(t('Delete "{name}"?', { name: item.name }), warn)) return;
        await api.del(`/content/${item.id}`);
        close(); toast(t('Deleted')); onSaved();
      }), 'danger')),
      item.id && btn(t('Preview'), () => openPreview(item.name, `content=${item.id}`), '', 'play'),
      btn(t('Cancel'), close),
      can('content') && btn(t('Save'), safely(async () => {
        const body = { name: name.value, config: cfg, tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean) };
        if (item.id) await api.patch(`/content/${item.id}`, body);
        else await api.post('/content', { ...body, type, folderId });
        close(); toast(t('Saved')); onSaved();
      }), 'primary'),
    ],
  });
}

function addDialog(meta, folderId, onDone) {
  const enabled = (x) => meta.core.includes(x);
  const coreTypes = [
    ['text', t('Text'), t('A styled message or ticker.')],
    ['url', t('Web page'), t('Any address that allows embedding.')],
    ['youtube', t('YouTube'), t('Plays silently with no controls.')],
    ['html', t('HTML'), t('Write your own page with live preview.')],
    ['composition', t('Composition'), t('Several items in zones on one screen.')],
    ['stream', t('Live stream'), t('A camera or a stream address.')],
    ['folder', t('Folder'), t('Everything in a directory on the server.')],
  ].filter(([x]) => enabled(x));
  const m = modal({
    title: t('Add to library'), wide: true,
    body: (close) => [
      h('div', { class: 'kicker' }, t('From your device')),
      h('div', { class: 'type-grid' }, h('label', { class: 'type-card' },
        icon('upload'), h('b', {}, t('Upload files')),
        h('span', {}, enabled('pdf') ? t('Pictures, videos, or PDF documents.') : t('Pictures or videos.')),
        h('input', {
          type: 'file', multiple: true, accept: `image/*,video/*${enabled('pdf') ? ',application/pdf' : ''}`,
          onchange: async (e) => { const files = [...e.target.files]; close(); await uploadFiles(files, folderId); onDone(); },
        }))),
      h('div', { class: 'kicker' }, t('Create')),
      h('div', { class: 'type-grid' },
        coreTypes.map(([x, label, text]) => h('button', { class: 'type-card', type: 'button', onclick: () => { close(); editContent({ type: x, config: {} }, meta, folderId, onDone); } }, icon(TYPE_ICONS[x]), h('b', {}, label), h('span', {}, text))),
        meta.plugins.map((p) => h('button', { class: 'type-card', type: 'button', onclick: () => { close(); editContent({ type: p.type, config: {} }, meta, folderId, onDone); } }, icon(TYPE_ICONS[p.type] || 'plugin'), h('b', {}, p.label), h('span', {}, t('Plugin'))))),
    ],
  });
  return m;
}

// ---------- page ----------
export async function libraryPage({ mount, isCurrent, onLeave }) {
  let meta = await api.get('/content-types');
  let items = [], folders = [];
  const selected = new Set();
  const load = async () => {
    [items, folders] = await Promise.all([api.get('/content'), api.get('/folders')]);
    selected.clear();
    if (isCurrent()) draw();
  };

  const grid = h('div');
  const foldersEl = h('nav', { class: 'folders', 'aria-label': t('Folders') });
  const bulk = h('div', { class: 'row' });

  const visible = () => {
    const q = filter.q.toLowerCase();
    return items.filter((c) => {
      if (filter.folder === 'none' && c.folderId) return false;
      if (filter.folder !== 'all' && filter.folder !== 'none' && c.folderId !== filter.folder) return false;
      if (filter.type && c.type !== filter.type) return false;
      if (q && !c.name.toLowerCase().includes(q) && !c.tags.some((x) => x.toLowerCase().includes(q))) return false;
      return true;
    });
  };

  const moveTo = safely(async (ids, folderId) => {
    await Promise.all(ids.map((cid) => api.patch(`/content/${cid}`, { folderId })));
    toast(t('Moved'));
    load();
  });

  const folderBtn = (fid, label, ic = 'folder') => h('button', {
    type: 'button', class: filter.folder === fid ? 'on' : '',
    onclick: () => { filter.folder = fid; draw(); },
    ondragover: (e) => { if (fid === 'all') return; e.preventDefault(); e.currentTarget.classList.add('drop'); },
    ondragleave: (e) => e.currentTarget.classList.remove('drop'),
    ondrop: (e) => {
      e.preventDefault(); e.stopPropagation();
      e.currentTarget.classList.remove('drop');
      const id = e.dataTransfer.getData('text/vitrine');
      if (id) moveTo(selected.has(id) ? [...selected] : [id], fid === 'none' ? null : fid);
    },
  }, icon(ic), h('span', { class: 'clip grow' }, label));

  function drawBulk() {
    bulk.replaceChildren();
    if (!selected.size) return;
    bulk.append(
      h('span', { class: 'chip accent' }, t('{n} selected', { n: selected.size })),
      select([['', t('Move to…')], ['__root', t('No folder')], ...folders.map((f) => [f.id, f.name])], '', (v) => { if (v) moveTo([...selected], v === '__root' ? null : v); }),
      btn(t('Delete'), safely(async () => {
        if (!await confirmDialog(t('Delete {n} items?', { n: selected.size }), t('They will also be removed from any playlists using them.'))) return;
        await Promise.all([...selected].map((cid) => api.del(`/content/${cid}`)));
        toast(t('Deleted')); load();
      }), 'danger sm'));
    bulk.style.width = '100%';
  }

  function drawItems() {
    const list = visible();
    if (!items.length) {
      grid.replaceChildren(empty(t('Your library is empty'), t('Drop files anywhere on this page, or add a web page, text, or a live stream.'), can('content') && btn(t('Add content'), () => addDialog(meta, null, load), 'primary', 'plus')));
      return;
    }
    if (!list.length) { grid.replaceChildren(empty(t('Nothing matches'), t('Try another search or folder.'))); return; }
    grid.replaceChildren(h('div', { class: 'items' }, list.map((c) => {
      const node = h('article', {
        class: `item ${selected.has(c.id) ? 'sel' : ''}`,
        draggable: 'true',
        ondragstart: (e) => e.dataTransfer.setData('text/vitrine', c.id),
      },
      can('content') && h('input', {
        type: 'checkbox', class: 'pick', checked: selected.has(c.id), 'aria-label': t('Select {name}', { name: c.name }),
        onchange: (e) => { if (e.target.checked) selected.add(c.id); else selected.delete(c.id); node.classList.toggle('sel', e.target.checked); drawBulk(); },
      }),
      h('button', { class: 'open', type: 'button', onclick: () => editContent(c, meta, null, load) },
        h('div', { style: { position: 'relative' } }, contentThumb(c), h('span', { class: 'badge-type' }, c.duration ? formatDuration(c.duration) : (meta.plugins.find((p) => p.type === c.type)?.label || typeLabel(c.type)))),
        h('div', { class: 'name clip' }, c.name),
        h('div', { class: 'meta' }, c.usage ? t('In {n} playlists', { n: c.usage }) : t('Unused'), c.size ? ` · ${formatBytes(c.size)}` : '')));
      return node;
    })));
  }

  function draw() {
    foldersEl.replaceChildren(
      folderBtn('all', t('All items'), 'library'),
      folderBtn('none', t('No folder')),
      ...folders.map((f) => h('div', { class: 'row', style: { gap: 0, flexWrap: 'nowrap' } },
        folderBtn(f.id, f.name),
        filter.folder === f.id && can('content') && iconBtn('trash', t('Delete folder'), safely(async () => {
          if (!await confirmDialog(t('Delete folder "{name}"?', { name: f.name }), t('The items inside stay in your library.'))) return;
          await api.del(`/folders/${f.id}`);
          filter.folder = 'all';
          load();
        })))),
      can('content') && h('button', {
        type: 'button',
        onclick: safely(async () => {
          const name = await prompt1(t('New folder'), t('Name'), '', t('Create'));
          if (name) { await api.post('/folders', { name }); load(); }
        }),
      }, icon('plus'), t('New folder')));
    drawItems();
    drawBulk();
  }

  const typesPresent = () => [...new Set(items.map((i) => i.type))];
  const typeSel = h('select', { 'aria-label': t('Type'), onchange: (e) => { filter.type = e.target.value; draw(); } });
  const fillTypes = () => typeSel.replaceChildren(h('option', { value: '' }, t('All types')), ...typesPresent().map((x) => h('option', { value: x, selected: filter.type === x }, meta.plugins.find((p) => p.type === x)?.label || typeLabel(x))));

  // Whole-page drop target
  const zone = h('div', { class: 'dropzone hide' }, t('Drop to upload'));
  document.body.append(zone);
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const enter = (e) => { if (hasFiles(e)) { depth++; zone.classList.remove('hide'); } };
  const leave = (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; zone.classList.add('hide'); } };
  const over = (e) => { if (hasFiles(e)) e.preventDefault(); };
  const drop = async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; zone.classList.add('hide');
    if (!can('content')) return;
    const fid = !['all', 'none'].includes(filter.folder) ? filter.folder : null;
    await uploadFiles([...e.dataTransfer.files], fid);
    load();
  };
  addEventListener('dragenter', enter); addEventListener('dragleave', leave); addEventListener('dragover', over); addEventListener('drop', drop);
  onLeave(() => {
    zone.remove();
    removeEventListener('dragenter', enter); removeEventListener('dragleave', leave); removeEventListener('dragover', over); removeEventListener('drop', drop);
  });

  await load();
  fillTypes();
  if (!isCurrent()) return;
  mount(h('div', {},
    h('header', { class: 'page-head' },
      h('div', {}, h('h1', {}, t('Library')), h('div', { class: 'sub' }, t('Everything your screens can show.'))),
      h('div', { class: 'actions' }, can('content') && btn(t('Add content'), () => addDialog(meta, !['all', 'none'].includes(filter.folder) ? filter.folder : null, async () => { await load(); fillTypes(); }), 'primary', 'plus'))),
    h('div', { class: 'toolbar' },
      h('input', { class: 'search', type: 'search', placeholder: t('Search names and tags'), 'aria-label': t('Search'), value: filter.q, oninput: (e) => { filter.q = e.target.value; drawItems(); } }),
      h('div', { style: { width: '170px' } }, typeSel),
      bulk),
    h('div', { class: 'lib-layout' }, foldersEl, grid)));
}
