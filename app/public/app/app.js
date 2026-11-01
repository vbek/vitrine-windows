import { h, icon, btn, toast, safely } from './ui.js';
import { api } from './api.js';
import { t, setLang, LANGS } from './i18n.js';
import { todayPage } from './pages/today.js';
import { libraryPage } from './pages/library.js';
import { playlistsPage, playlistEditor } from './pages/playlists.js';
import { screensPage } from './pages/screens.js';
import { broadcastPage } from './pages/broadcast.js';
import { insightsPage } from './pages/insights.js';
import { settingsPage } from './pages/settings.js';
import { profilePage } from './pages/profile.js';

export const session = { user: null, brand: {}, language: 'en' };
const AREAS = { owner: ['content', 'device', 'security', 'owner'], admin: ['content', 'device', 'security'], content: ['content'], device: ['device'] };
export const can = (area) => AREAS[session.user?.role]?.includes(area);

const root = document.getElementById('app');
let cleanup = null;

export function go(path) {
  history.pushState({}, '', path);
  render();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); go(a.getAttribute('href')); }
});
window.addEventListener('popstate', () => render());
window.addEventListener('vt:signedout', () => { session.user = null; boot(); });

// ---------- live updates ----------
let source;
const liveListeners = new Set();
export function onLive(fn) { liveListeners.add(fn); return () => liveListeners.delete(fn); }
function connectLive() {
  source?.close();
  source = new EventSource('/api/events');
  source.onmessage = (e) => { const m = JSON.parse(e.data); liveListeners.forEach((f) => f(m)); };
}

// ---------- theme ----------
const getTheme = () => { try { return localStorage.getItem('vt.theme'); } catch { return null; } };
function applyTheme(v) {
  if (v) document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
}
applyTheme(getTheme());
function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  try { localStorage.setItem('vt.theme', next); } catch { /* preference just won't persist */ }
  applyTheme(next);
  render();
}
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

export function applyBrand() {
  const b = session.brand;
  document.title = b.name || 'Vitrine';
  if (b.accent) document.documentElement.style.setProperty('--accent', b.accent);
  else document.documentElement.style.removeProperty('--accent');
}

const brandEl = () => h('a', { class: 'brand', href: '/', 'data-link': true },
  session.brand.logo ? h('img', { src: session.brand.logo, alt: session.brand.name }) : h('span', { class: 'brand-mark' }, icon('v')),
  !session.brand.logo && h('span', { class: 'clip' }, session.brand.name || 'Vitrine'));

// ---------- routes ----------
const NAV = () => [
  { path: '/', label: t('Today'), icon: 'today' },
  { path: '/library', label: t('Library'), icon: 'library' },
  { path: '/playlists', label: t('Playlists'), icon: 'playlist' },
  { path: '/screens', label: t('Screens'), icon: 'screens' },
  { path: '/broadcast', label: t('Broadcast'), icon: 'broadcast' },
  { path: '/insights', label: t('Insights'), icon: 'insights' },
];
const isOn = (path) => (path === '/' ? location.pathname === '/' : location.pathname.startsWith(path));

function shell(content) {
  const nav = NAV();
  const security = can('security');
  const rail = h('aside', { class: 'rail' },
    brandEl(),
    h('nav', { class: 'nav', 'aria-label': t('Main') },
      nav.map((n) => h('a', { href: n.path, 'data-link': true, class: isOn(n.path) ? 'on' : '', 'aria-current': isOn(n.path) ? 'page' : null, title: n.label }, icon(n.icon), h('span', {}, n.label))),
      h('div', { class: 'spacer' }),
      security && h('a', { href: '/settings', 'data-link': true, class: isOn('/settings') ? 'on' : '', title: t('Settings') }, icon('settings'), h('span', {}, t('Settings'))),
      h('a', { href: '/profile', 'data-link': true, class: isOn('/profile') ? 'on' : '', title: session.user.name }, icon('user'), h('span', { class: 'clip' }, session.user.name || session.user.username))),
    h('div', { class: 'rail-foot' },
      h('button', { class: 'btn icon sm ghost', type: 'button', onclick: toggleTheme, 'aria-label': t('Switch theme'), title: t('Switch theme') }, icon(isDark() ? 'sun' : 'moon'))));

  const mobileMain = nav.slice(0, 4);
  const moreOn = !mobileMain.some((n) => isOn(n.path));
  const bar = h('nav', { class: 'mobile-bar', 'aria-label': t('Main') },
    mobileMain.map((n) => h('a', { href: n.path, 'data-link': true, class: isOn(n.path) ? 'on' : '' }, icon(n.icon), n.label)),
    h('button', { type: 'button', class: moreOn ? 'on' : '', onclick: () => openMore(nav.slice(4)) }, icon('more'), t('More')));

  return h('div', { class: 'shell' }, rail, h('main', { class: 'main', id: 'main' }, content), bar);
}

async function openMore(extra) {
  const { modal } = await import('./ui.js');
  const links = [...extra, can('security') && { path: '/settings', label: t('Settings'), icon: 'settings' }, { path: '/profile', label: t('Profile'), icon: 'user' }].filter(Boolean);
  const m = modal({
    title: t('More'),
    body: (close) => h('div', { class: 'stack' },
      links.map((l) => h('a', { class: 'btn', style: { justifyContent: 'flex-start' }, href: l.path, 'data-link': true, onclick: close }, icon(l.icon), l.label)),
      btn(isDark() ? t('Use light theme') : t('Use dark theme'), () => { close(); toggleTheme(); }, '', isDark() ? 'sun' : 'moon')),
  });
  return m;
}

function route() {
  const p = location.pathname;
  let m;
  if (p === '/') return todayPage;
  if (p === '/library') return libraryPage;
  if (p === '/playlists') return playlistsPage;
  if ((m = /^\/playlists\/([\w-]+)$/.exec(p))) return (ctx) => playlistEditor(ctx, m[1]);
  if (p === '/screens') return screensPage;
  if (p === '/broadcast') return broadcastPage;
  if (p === '/insights') return insightsPage;
  if (p === '/settings' || p.startsWith('/settings/')) return settingsPage;
  if (p === '/profile') return profilePage;
  return ({ mount }) => mount(h('div', { class: 'empty', style: { marginTop: '40px' } }, h('h3', {}, t('Page not found')), h('a', { class: 'btn', href: '/', 'data-link': true }, t('Go to Today'))));
}

async function render() {
  cleanup?.();
  cleanup = null;
  if (!session.user) return renderAuth();
  const slot = h('div', {}, h('div', { class: 'loading' }, t('Loading…')));
  root.replaceChildren(shell(slot));
  window.scrollTo(0, 0);
  const page = route();
  const token = {};
  render.token = token;
  const disposers = [];
  try {
    await page({
      mount: (node) => { if (render.token === token) slot.replaceChildren(node); },
      live: (fn) => disposers.push(onLive(fn)),
      onLeave: (fn) => disposers.push(fn),
      isCurrent: () => render.token === token,
    });
  } catch (e) {
    if (render.token === token) slot.replaceChildren(h('div', { class: 'empty', style: { marginTop: '40px' } }, h('h3', {}, t('This page could not load')), h('p', {}, e.message), btn(t('Try again'), () => render())));
  }
  cleanup = () => disposers.forEach((d) => d());
}
export const refresh = () => render();
export const screenOrigin = () => session.screenOrigin || location.origin;

// ---------- sign-in + first run ----------
function renderAuth() {
  const needsSetup = session.needsSetup;
  if (session.setupBlocked) {
    root.replaceChildren(h('div', { class: 'auth' },
      h('section', { class: 'auth-art' }, brandEl(),
        h('h1', {}, t('Every screen, '), h('em', {}, t('dressed.')))),
      h('section', { class: 'auth-form' }, h('div', {},
        h('h2', {}, t('Finish setup on the computer')),
        h('p', { class: 'muted', style: { margin: '6px 0 0' } }, t('Open Vitrine on the computer running it and create the owner account there. You can then sign in from this device.'))))));
    return;
  }
  const username = h('input', { autocomplete: 'username', required: true, autofocus: true });
  const password = h('input', { type: 'password', autocomplete: needsSetup ? 'new-password' : 'current-password', required: true, minlength: needsSetup ? 8 : null });
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}' });
  const codeField = h('div', { class: 'field hide' }, h('label', {}, t('Code from your authenticator app'), code));
  const err = h('div', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, needsSetup ? t('Create owner account') : t('Sign in'));

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const r = needsSetup
          ? await api.post('/auth/setup', { username: username.value, password: password.value, name: username.value })
          : await api.post('/auth/login', { username: username.value, password: password.value, code: code.value || undefined });
        if (r.needsCode) { codeField.classList.remove('hide'); code.focus(); }
        else { session.needsSetup = false; session.user = r.user; afterLogin(); }
      } catch (ex) { err.textContent = ex.message; }
      submit.disabled = false;
    },
  },
    h('div', {}, h('h2', {}, needsSetup ? t('Welcome. Set up your studio.') : t('Sign in')),
      needsSetup && h('p', { class: 'muted', style: { margin: '6px 0 0' } }, t('This first account is the owner and can manage everything.'))),
    h('div', { class: 'field' }, h('label', {}, t('Username'), username)),
    h('div', { class: 'field' }, h('label', {}, t('Password'), password), needsSetup && h('div', { class: 'hint' }, t('At least 8 characters.'))),
    codeField, err, submit);

  root.replaceChildren(h('div', { class: 'auth' },
    h('section', { class: 'auth-art' }, brandEl(),
      h('h1', {}, t('Every screen, '), h('em', {}, t('dressed.'))),
      h('p', { class: 'muted', style: { color: '#bdb8ab', margin: 0, maxWidth: '44ch' } }, t('Your signage, on your own server. Upload it, schedule it, and put it on any display with a browser.'))),
    h('section', { class: 'auth-form' }, form)));
}

function afterLogin() {
  setLang(session.user.lang || session.language);
  connectLive();
  render();
}

async function boot() {
  try {
    const s = await api.get('/auth/state');
    Object.assign(session, s);
    setLang(s.user?.lang || s.language || (navigator.language || 'en').slice(0, 2));
    applyBrand();
    if (s.user) connectLive();
    render();
  } catch (e) {
    root.replaceChildren(h('div', { class: 'empty', style: { margin: '40px' } }, h('h3', {}, t('Cannot reach the server')), h('p', {}, e.message), btn(t('Try again'), boot)));
  }
}
boot();
export { LANGS, toast, safely };
