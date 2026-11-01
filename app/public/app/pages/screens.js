import { h, icon, btn, iconBtn, modal, toast, safely, confirmDialog, empty, field, select, dayPicker, copyButton, timeAgo, DAYS } from '../ui.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { can, refresh, screenOrigin } from '../app.js';
import { screenCard } from './today.js';

let tab = 'screens';

const options = (list, none) => [['', none], ...list.map((x) => [x.id, x.name])];

function rulesEditor(targetType, targetId, playlists) {
  const root = h('div', { class: 'stack' });
  const load = safely(async () => {
    const rules = await api.get(`/rules?targetType=${targetType}&targetId=${targetId}`);
    const days = DAYS();
    root.replaceChildren(
      rules.length ? h('div', {}, rules.map((r) => h('div', { class: 'row between', style: { padding: '7px 0', borderBottom: '1px solid var(--hair)', flexWrap: 'nowrap' } },
        h('div', { class: 'grow' },
          h('div', { style: { fontWeight: 600 } }, r.playlistId ? r.playlistName : t('Screen off')),
          h('div', { class: 'small muted' }, `${r.days.length && r.days.length < 7 ? r.days.map((d) => days[d]).join(' ') : t('Every day')} · ${r.from}–${r.to}${r.startDate ? ` · ${r.startDate} → ${r.endDate || '…'}` : ''}`)),
        can('device') && iconBtn('trash', t('Remove rule'), safely(async () => { await api.del(`/rules/${r.id}`); load(); }))))) : h('p', { class: 'small muted', style: { margin: 0 } }, t('No time rules. It plays its assigned playlist all day.')),
      can('device') && btn(t('Add time rule'), () => ruleDialog(targetType, targetId, playlists, load), 'sm', 'plus'));
  });
  load();
  return root;
}

function ruleDialog(targetType, targetId, playlists, onDone) {
  const r = { playlistId: '', days: [0, 1, 2, 3, 4], from: '09:00', to: '17:00', startDate: '', endDate: '', priority: 0 };
  modal({
    title: t('Add time rule'),
    body: [
      field(t('During these hours, show'), select(options(playlists, t('Nothing (screen off)')), '', (v) => { r.playlistId = v; })),
      h('div', { class: 'field' }, h('div', { class: 'label' }, t('On these days')), dayPicker(r.days, (v) => { r.days = v; })),
      h('div', { class: 'grid2' },
        field(t('From'), h('input', { type: 'time', value: r.from, onchange: (e) => { r.from = e.target.value; } })),
        field(t('Until'), h('input', { type: 'time', value: r.to, onchange: (e) => { r.to = e.target.value; } }))),
      h('div', { class: 'grid2' },
        field(t('First date (optional)'), h('input', { type: 'date', onchange: (e) => { r.startDate = e.target.value; } })),
        field(t('Last date (optional)'), h('input', { type: 'date', onchange: (e) => { r.endDate = e.target.value; } }))),
      field(t('Priority'), h('input', { type: 'number', value: 0, onchange: (e) => { r.priority = Number(e.target.value); } }), t('When rules overlap, the higher number wins.')),
    ],
    foot: (close) => [btn(t('Cancel'), close), btn(t('Add'), safely(async () => {
      await api.post('/rules', { ...r, targetType, targetId });
      close(); onDone();
    }), 'primary')],
  });
}

export async function openScreen(s) {
  const [groups, playlists] = await Promise.all([api.get('/groups'), api.get('/playlists')]);
  const edit = can('device');
  const set = { rotation: 'normal', transition: '', ...s.settings };
  const name = h('input', { value: s.name, disabled: !edit });
  const location_ = h('input', { value: s.location || '', placeholder: t('Lobby, 2nd floor'), disabled: !edit });
  let groupId = s.groupId || '', playlistId = s.playlistId || '';
  const send = (command, msg) => safely(async () => {
    const r = await api.post(`/screens/${s.id}/command`, { command });
    toast(r.delivered ? msg : t('The screen is offline, so it did not receive this.'), !r.delivered);
  });

  modal({
    title: s.name, wide: true,
    body: [
      h('div', { class: 'row' },
        h('span', { class: `chip ${s.online ? 'live' : ''}` }, h('span', { class: `dot ${s.online ? 'on' : ''}` }), s.online ? t('On air') : t('Offline')),
        s.nowPlaying && h('span', { class: 'chip clip' }, s.nowPlaying),
        s.offlineReady && h('span', { class: 'chip' }, icon('check'), t('Ready for offline')),
        h('span', { class: 'small muted' }, `${t('Last seen')} ${timeAgo(s.lastSeen)}`)),
      edit && h('div', { class: 'row' },
        btn(t('Identify'), send('identify', t('Showing the name on screen')), 'sm'),
        btn(t('Refresh content'), send('refresh', t('Refreshing')), 'sm', 'refresh'),
        btn(t('Reload player'), send('reload', t('Reloading')), 'sm')),
      h('div', { class: 'grid2' }, field(t('Name'), name), field(t('Location'), location_)),
      h('div', { class: 'grid2' },
        field(t('Group'), select(options(groups, t('No group')), groupId, (v) => { groupId = v; })),
        field(t('Playlist'), select(options(playlists, t('Use the group\'s playlist')), playlistId, (v) => { playlistId = v; }))),
      h('div', { class: 'grid2' },
        field(t('Rotation'), select([['normal', t('Normal')], ['left', t('Portrait, turned left')], ['right', t('Portrait, turned right')], ['inverted', t('Upside down')]], set.rotation, (v) => { set.rotation = v; })),
        field(t('Transition'), select([['', t('Use the playlist\'s')], ['fade', t('Fade')], ['slide', t('Slide')], ['zoom', t('Zoom')], ['wipe', t('Wipe')], ['none', t('None')]], set.transition, (v) => { set.transition = v; }))),
      h('div', { class: 'field' }, h('div', { class: 'label' }, t('Time rules')), rulesEditor('screen', s.id, playlists)),
      (s.ip || s.resolution) && h('div', { class: 'small muted mono' }, [s.ip, s.resolution, s.userAgent].filter(Boolean).join(' · ')),
    ],
    foot: (close) => [
      edit && h('div', { class: 'left' }, btn(t('Remove'), safely(async () => {
        if (!await confirmDialog(t('Remove "{name}"?', { name: s.name }), t('The display goes back to showing a pairing code.'), { action: t('Remove') })) return;
        await api.del(`/screens/${s.id}`);
        close(); refresh();
      }), 'danger')),
      btn(t('Close'), close),
      edit && btn(t('Save'), safely(async () => {
        await api.patch(`/screens/${s.id}`, { name: name.value, location: location_.value, groupId, playlistId, settings: set });
        close(); toast(t('Saved')); refresh();
      }), 'primary'),
    ],
  });
}

function addScreenDialog(groups, playlists) {
  const code = h('input', { placeholder: 'ABC123', autocomplete: 'off', style: { fontFamily: 'var(--display)', fontSize: '28px', fontWeight: 700, letterSpacing: '.2em', textTransform: 'uppercase', textAlign: 'center' }, maxlength: 7, 'aria-label': t('Pairing code') });
  const name = h('input', { placeholder: t('Front window') });
  let groupId = '', playlistId = '';
  const tv = `${screenOrigin()}/tv`;
  modal({
    title: t('Add a screen'),
    body: [
      h('ol', { style: { margin: 0, paddingLeft: '20px' }, class: 'stack' },
        h('li', {}, t('On the display, open this address in a browser:'), h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'nowrap' } }, h('div', { class: 'code-block grow' }, tv), copyButton(tv))),
        h('li', {}, t('A six-character code appears. Enter it here:'), h('div', { style: { marginTop: '6px' } }, code))),
      field(t('Name'), name),
      h('div', { class: 'grid2' },
        field(t('Playlist'), select(options(playlists, t('Choose later')), '', (v) => { playlistId = v; })),
        field(t('Group'), select(options(groups, t('No group')), '', (v) => { groupId = v; }))),
      h('details', {}, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, t('Run it full screen when the display starts')),
        h('p', { class: 'small muted' }, t('Any Chromium browser can start straight into the player:')),
        h('div', { class: 'code-block' }, `chromium --kiosk --autoplay-policy=no-user-gesture-required --noerrdialogs ${tv}`),
        h('p', { class: 'small muted' }, t('The scripts folder has ready-made setup for Raspberry Pi and Windows. Smart TVs can open the address in their built-in browser.'))),
    ],
    foot: (close) => [btn(t('Cancel'), close), btn(t('Pair screen'), safely(async () => {
      await api.post('/screens/pair', { code: code.value, name: name.value, groupId, playlistId });
      close(); toast(t('Screen paired')); refresh();
    }), 'primary')],
  });
  code.focus();
}

function groupDialog(g, playlists) {
  const name = h('input', { value: g?.name || '' });
  let playlistId = g?.playlistId || '';
  const edit = can('device');
  const url = g && `${screenOrigin()}/group/${g.id}`;
  modal({
    title: g ? g.name : t('New group'),
    body: [
      field(t('Name'), name),
      field(t('Playlist'), select(options(playlists, t('None')), playlistId, (v) => { playlistId = v; }), t('Screens in the group play this unless they have their own playlist.')),
      g && h('div', { class: 'field' }, h('div', { class: 'label' }, t('Time rules')), rulesEditor('group', g.id, playlists)),
      g && h('div', { class: 'field' }, h('div', { class: 'label' }, t('Link for displays that cannot be paired')), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('div', { class: 'code-block grow' }, url), copyButton(url)), h('div', { class: 'hint' }, t('Needs public player links turned on in Settings.'))),
    ],
    foot: (close) => [
      g && edit && h('div', { class: 'left' }, btn(t('Delete'), safely(async () => {
        if (!await confirmDialog(t('Delete group "{name}"?', { name: g.name }), t('Its screens stay paired, with no group.'))) return;
        await api.del(`/groups/${g.id}`);
        close(); refresh();
      }), 'danger')),
      btn(t('Cancel'), close),
      edit && btn(t('Save'), safely(async () => {
        if (g) await api.patch(`/groups/${g.id}`, { name: name.value, playlistId });
        else await api.post('/groups', { name: name.value, playlistId });
        close(); refresh();
      }), 'primary'),
    ],
  });
}

export async function screensPage({ mount, live, isCurrent }) {
  const edit = can('device');
  const body = h('div');

  const draw = async () => {
    const [screens, groups, playlists] = await Promise.all([api.get('/screens'), api.get('/groups'), api.get('/playlists')]);
    if (!isCurrent()) return;
    tabs.replaceChildren(
      h('button', { type: 'button', class: tab === 'screens' ? 'on' : '', onclick: () => { tab = 'screens'; draw(); } }, `${t('Screens')} (${screens.length})`),
      h('button', { type: 'button', class: tab === 'groups' ? 'on' : '', onclick: () => { tab = 'groups'; draw(); } }, `${t('Groups')} (${groups.length})`));
    actions.replaceChildren(edit ? (tab === 'screens'
      ? btn(t('Add a screen'), () => addScreenDialog(groups, playlists), 'primary', 'plus')
      : btn(t('New group'), () => groupDialog(null, playlists), 'primary', 'plus')) : '');

    if (tab === 'screens') {
      body.replaceChildren(screens.length
        ? h('div', { class: 'wall' }, screens.map((s) => screenCard(s, openScreen)))
        : empty(t('No screens yet'), t('Open the player on any display with a browser, then pair it with the code it shows.'), edit && btn(t('Add a screen'), () => addScreenDialog(groups, playlists), 'primary', 'plus')));
    } else {
      body.replaceChildren(groups.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, t('Group')), h('th', {}, t('Playlist')), h('th', { class: 'num' }, t('On air')), h('th', { class: 'num' }, t('Time rules')), h('th', {}))),
          h('tbody', {}, groups.map((g) => h('tr', {},
            h('td', { style: { fontWeight: 600 } }, g.name),
            h('td', {}, g.playlist?.name || h('span', { class: 'muted' }, t('None'))),
            h('td', { class: 'num' }, `${g.online} / ${g.screens}`),
            h('td', { class: 'num' }, g.ruleCount),
            h('td', { class: 'num' }, btn(t('Edit'), () => groupDialog(g, playlists), 'sm')))))))
        : empty(t('No groups yet'), t('Groups let many screens share one playlist and schedule.'), edit && btn(t('New group'), () => groupDialog(null, playlists), 'primary', 'plus')));
    }
  };
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const actions = h('div', { class: 'actions' });
  live((m) => { if (m.type === 'screens' && !document.querySelector('dialog[open]')) draw().catch(() => {}); });
  await draw();
  mount(h('div', {},
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, t('Screens')), h('div', { class: 'sub' }, t('Every display you run, live.'))), actions),
    tabs, body));
}
