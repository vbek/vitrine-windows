import { t } from './i18n.js';

/** Hyperscript. Strings are always text nodes; raw markup goes through `html` only for trusted SVG. */
export function h(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'value') e.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'multiple') e[k] = Boolean(v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  append(e, children);
  return e;
}
function append(e, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const P = {
  today: '<path d="M3 5h18v12H3zM8 21h8M12 17v4"/>',
  library: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  playlist: '<path d="M4 6h16M4 12h10M4 18h10M17 14v7l4-3.5z"/>',
  screens: '<path d="M2 4h14v10H2zM6 18h6M9 14v4M18 8h4v12h-6v-3"/>',
  broadcast: '<path d="M4 10v4h3l9 5V5L7 10zM19 9a4 4 0 0 1 0 6"/>',
  insights: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l5 5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  grip: '<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  image: '<path d="M3 5h18v14H3z"/><circle cx="9" cy="10" r="1.5"/><path d="M4 18l6-5 4 3 3-2 3 3"/>',
  video: '<path d="M3 6h13v12H3zM16 10l5-3v10l-5-3z"/>',
  url: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  html: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  youtube: '<path d="M3 6h18v12H3zM10 9l5 3-5 3z"/>',
  stream: '<circle cx="12" cy="12" r="3"/><path d="M6 6a9 9 0 0 0 0 12M18 6a9 9 0 0 1 0 12"/>',
  composition: '<path d="M3 4h18v16H3zM14 4v16M3 13h11"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  pdf: '<path d="M6 3h9l4 4v14H6zM15 3v4h4M9 13h6M9 17h6"/>',
  embed: '<path d="M4 6h10v10H4zM8 16v3h12V9h-3"/>',
  plugin: '<path d="M9 3v5H4v4h2a2 2 0 0 1 0 4H4v5h5v-2a2 2 0 0 1 4 0v2h8v-8h-2a2 2 0 0 1 0-4h2V5h-8V3z"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>',
  copy: '<path d="M8 8h12v12H8zM4 16V4h12"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
  moon: '<path d="M20 14a8 8 0 1 1-10-10 7 7 0 0 0 10 10z"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  v: '<path d="M4 4l8 17 8-17" stroke-width="4"/>',
};
export const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || P.plugin;
  return s;
};

export const btn = (label, onClick, cls = '', ic) => h('button', { class: `btn ${cls}`, type: 'button', onclick: onClick }, ic && icon(ic), label);
export const iconBtn = (ic, label, onClick, cls = '') => h('button', { class: `btn icon sm ghost ${cls}`, type: 'button', 'aria-label': label, title: label, onclick: onClick }, icon(ic));

export function toast(msg, err = false) {
  const n = h('div', { class: `toast ${err ? 'err' : ''}`, role: err ? 'alert' : 'status' }, msg);
  document.getElementById('toasts').append(n);
  setTimeout(() => n.remove(), err ? 6000 : 3000);
}
/** Runs an async action and surfaces any failure as a toast, so handlers stay short. */
export const safely = (fn) => async (...a) => {
  try { return await fn(...a); } catch (e) { toast(e.message, true); }
};

/** Opens a dialog. `render(close)` returns the body; footer actions come from `actions(close)`. */
export function modal({ title, body, foot, wide, onClose }) {
  const d = h('dialog', { class: `modal ${wide ? 'wide' : ''}` });
  const close = () => { d.close(); };
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  const bodyEl = h('div', { class: 'modal-body' }, typeof body === 'function' ? body(close) : body);
  const footItems = typeof foot === 'function' ? foot(close) : foot;
  d.append(
    h('div', { class: 'modal-head' }, h('h2', { class: 'clip' }, title), iconBtn('close', t('Close'), close)),
    bodyEl,
    footItems && h('div', { class: 'modal-foot' }, footItems),
  );
  document.body.append(d);
  d.showModal();
  return { close, el: d, body: bodyEl };
}

export function confirmDialog(title, message, { danger = true, action = t('Delete') } = {}) {
  return new Promise((res) => {
    let ok = false;
    modal({
      title, body: h('p', { style: { margin: 0 } }, message),
      onClose: () => res(ok),
      foot: (close) => [btn(t('Cancel'), close), btn(action, () => { ok = true; close(); }, danger ? 'danger' : 'primary')],
    });
  });
}

export function prompt1(title, label, value = '', action = t('Save')) {
  return new Promise((res) => {
    let result = null;
    const input = h('input', { value, autofocus: true });
    const submit = (close) => { result = input.value.trim(); close(); };
    const m = modal({
      title,
      body: h('div', { class: 'field' }, h('label', {}, label, input)),
      onClose: () => res(result),
      foot: (close) => [btn(t('Cancel'), close), btn(action, () => submit(close), 'primary')],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(m.close); });
    input.select();
  });
}

let fieldSeq = 0;
export function field(label, control, hint) {
  // Tie the label to its control; composite controls (a row holding a color input) use the first one inside.
  const target = control.matches?.('input, select, textarea') ? control : control.querySelector?.('input, select, textarea');
  const fid = target ? (target.id ||= `f${++fieldSeq}`) : null;
  return h('div', { class: 'field' }, h('label', { for: fid }, label), control, hint && h('div', { class: 'hint' }, hint));
}
export const select = (options, value, onchange) => h('select', { onchange: onchange && ((e) => onchange(e.target.value)) },
  options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, l)));
export const check = (label, checked, onchange) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange?.(e.target.checked) }), label);
export const switchEl = (checked, onchange, label) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, 'aria-label': label, onchange: (e) => onchange(e.target.checked, e.target) }), h('i'));

export function segmented(options, value, onchange) {
  const root = h('div', { class: 'seg', role: 'group' });
  const render = (val) => {
    root.replaceChildren(...options.map(([v, l]) => h('button', {
      type: 'button', class: v === val ? 'on' : '', 'aria-pressed': String(v === val),
      onclick: () => { render(v); onchange(v); },
    }, l)));
  };
  render(value);
  return root;
}

export const DAYS = () => [t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat'), t('Sun')];
export function dayPicker(selected, onchange) {
  const set = new Set(selected);
  return h('div', { class: 'days' }, DAYS().map((d, i) => h('label', {},
    h('input', { type: 'checkbox', checked: set.has(i), onchange: (e) => { if (e.target.checked) set.add(i); else set.delete(i); onchange([...set].sort()); } }),
    h('span', {}, d))));
}

export const formatBytes = (n) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
export function formatDuration(s) {
  s = Math.round(s || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
export function timeAgo(iso) {
  if (!iso) return t('never');
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.floor(s / 3600) });
  return new Date(iso).toLocaleDateString();
}

export function scheduleSummary(s) {
  const dt = (v) => (v ? new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const days = DAYS();
  switch (s?.mode) {
    case 'dates':
      return s.end ? `${dt(s.start) || t('Now')} → ${dt(s.end)}` : t('From {when}', { when: dt(s.start) });
    case 'week':
      return `${days[s.startDay ?? 0]} ${s.startTime || '00:00'} → ${days[s.endDay ?? 0]} ${s.endTime || '00:00'}`;
    case 'daily': {
      const d = s.days?.length && s.days.length < 7 ? `${[...s.days].sort().map((i) => days[i]).join(' ')} ` : '';
      return `${d}${s.from || '00:00'}–${s.to || '00:00'}`;
    }
    default: return null;
  }
}

/** A framed thumbnail for any content item. */
export function contentThumb(c) {
  if (!c) return h('div', { class: 'window' }, icon('playlist'));
  if (c.thumb) return h('div', { class: 'window' }, h('img', { src: c.thumb, alt: '', loading: 'lazy' }));
  if (c.type === 'video' && c.url) return h('div', { class: 'window' }, h('video', { src: `${c.url}#t=0.5`, muted: true, preload: 'metadata', playsinline: true }));
  if (c.type === 'text' && c.config?.text) {
    return h('div', { class: 'window', style: { background: c.config.bg || '#000', color: c.config.color || '#fff' } }, h('div', { class: 'tile-text' }, c.config.text));
  }
  return h('div', { class: 'window' }, icon(TYPE_ICONS[c.type] || 'plugin'));
}
export const TYPE_ICONS = { image: 'image', video: 'video', url: 'url', html: 'html', youtube: 'youtube', stream: 'stream', folder: 'folder', composition: 'composition', text: 'text', pdf: 'pdf', embed: 'embed', clock: 'clock' };
export const typeLabel = (type) => ({
  image: t('Image'), video: t('Video'), url: t('Web page'), html: t('HTML'), youtube: t('YouTube'), stream: t('Live stream'),
  folder: t('Folder'), composition: t('Composition'), text: t('Text'),
}[type] || type);

export const empty = (title, text, action) => h('div', { class: 'empty' }, h('h3', {}, title), h('p', {}, text), action);

export function copyButton(text) {
  return btn(t('Copy'), async () => {
    try { await navigator.clipboard.writeText(text); toast(t('Copied')); }
    catch { toast(t('Copy this manually: your browser blocked clipboard access.'), true); }
  }, 'sm', 'copy');
}

// A single shared tooltip for chart marks.
let tipEl;
export function tooltip(target, text) {
  const show = (e) => {
    tipEl ||= document.body.appendChild(h('div', { class: 'tip', role: 'tooltip' }));
    tipEl.textContent = text;
    tipEl.classList.remove('hide');
    const r = target.getBoundingClientRect();
    const x = e?.clientX ?? r.left + r.width / 2;
    tipEl.style.left = `${Math.min(x + 12, innerWidth - tipEl.offsetWidth - 8)}px`;
    tipEl.style.top = `${(e?.clientY ?? r.top) - 34}px`;
  };
  const hide = () => tipEl?.classList.add('hide');
  target.addEventListener('pointermove', show);
  target.addEventListener('pointerleave', hide);
  target.addEventListener('focus', () => show());
  target.addEventListener('blur', hide);
}
