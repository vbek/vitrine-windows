import { h, icon, btn, empty, safely, timeAgo } from '../ui.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { go, can, screenOrigin } from '../app.js';
import { openScreen } from './screens.js';

export function screenCard(s, onOpen) {
  return h('button', { class: `screen-card ${s.online ? '' : 'off'}`, type: 'button', onclick: () => onOpen(s) },
    h('div', { class: 'window' },
      s.nowPlayingThumb ? h('img', { src: s.nowPlayingThumb, alt: '' }) : icon('screens'),
      s.online && s.nowPlaying && h('div', { class: 'overlay-label clip' }, s.nowPlaying)),
    h('div', { class: 'cap' },
      h('div', { class: 'name' }, h('span', { class: `dot ${s.online ? 'on' : ''}` }), h('span', { class: 'clip' }, s.name)),
      h('div', { class: 'small muted clip' }, s.online
        ? (s.effectivePlaylist?.name || t('No playlist assigned'))
        : t('Offline, last seen {when}', { when: timeAgo(s.lastSeen) }))));
}

export async function todayPage({ mount, live, isCurrent }) {
  const draw = async () => {
    const d = await api.get('/overview');
    if (!isCurrent()) return;
    const offline = d.screens.filter((s) => !s.online).length;
    const hour = new Date().getHours();
    const greeting = hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');

    mount(h('div', {},
      h('header', { class: 'page-head' },
        h('div', {}, h('h1', {}, greeting), h('div', { class: 'sub' },
          d.counts.screens
            ? (offline ? t('On air: {on} of {total}. Offline: {off}.', { on: d.counts.online, total: d.counts.screens, off: offline }) : t('All {n} screens are on air.', { n: d.counts.screens }))
            : t('Three steps and your first screen is live.'))),
        h('div', { class: 'actions' },
          btn(t('Broadcast'), () => go('/broadcast'), 'danger', 'broadcast'),
          btn(t('Upload content'), () => go('/library'), 'primary', 'upload'))),
      d.broadcasts.map((b) => h('div', { class: 'alert-bar', role: 'status' },
        h('b', {}, t('On air now:')), h('span', { class: 'grow' }, b.title || b.message),
        btn(t('End broadcast'), safely(async () => { await api.post(`/broadcasts/${b.id}/end`); draw(); }), 'sm'))),
      d.counts.screens === 0 && d.counts.content === 0 ? onboarding(d) : main(d, draw)));
  };
  live((m) => { if (m.type === 'screens' || m.type === 'changed') draw().catch(() => {}); });
  await draw();
}

function main(d) {
  return h('div', {},
    h('div', { class: 'stats' },
      stat(d.counts.online, t('Screens on air'), '/screens'),
      stat(d.counts.playlists, t('Playlists'), '/playlists'),
      stat(d.counts.content, t('Items in library'), '/library'),
      stat(d.counts.playsToday, t('Plays today'), '/insights')),
    h('div', { class: d.activity.length ? 'two-col' : '' },
      h('section', {},
        h('h2', { class: 'section-title' }, t('On the wall')),
        d.screens.length
          ? h('div', { class: 'wall' }, d.screens.map((s) => screenCard(s, openScreen)))
          : empty(t('No screens yet'), t('Open the player on a display and pair it with a code.'), btn(t('Add a screen'), () => go('/screens'), 'primary', 'plus'))),
      d.activity.length > 0 && h('section', {},
        h('h2', { class: 'section-title' }, t('Recent activity')),
        h('ul', { class: 'feed' }, d.activity.map((a) => h('li', {},
          h('div', { class: 'clip' }, h('b', {}, a.username || t('System')), ' · ', a.action.replace('.', ' '), a.entity ? ` · ${a.entity}` : ''),
          h('div', { class: 'small muted' }, timeAgo(a.at))))))));
}

const stat = (value, label, href) => h('a', { class: 'stat', href, 'data-link': true }, h('b', {}, value), h('span', { class: 'small muted' }, label));

function onboarding() {
  const step = (n, title, text, action) => h('div', { class: 'panel stack' }, h('div', { class: 'kicker' }, `${t('Step')} ${n}`), h('h3', { style: { fontSize: '21px', fontWeight: 600 } }, title), h('p', { class: 'muted', style: { margin: 0, flex: 1 } }, text), action);
  return h('div', { class: 'grid3' },
    step(1, t('Add content'), t('Pictures, videos, PDFs, web pages, or text.'), btn(t('Open library'), () => go('/library'), 'primary')),
    step(2, t('Build a playlist'), t('Put items in order and decide when each one plays.'), can('content') ? btn(t('Open playlists'), () => go('/playlists')) : null),
    step(3, t('Pair a screen'), `${t('Open this address on the display:')} ${screenOrigin()}/tv`, btn(t('Open screens'), () => go('/screens'))));
}
