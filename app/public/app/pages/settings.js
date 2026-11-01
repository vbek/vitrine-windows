import { h, btn, iconBtn, modal, toast, safely, confirmDialog, field, select, check, switchEl, empty, timeAgo, copyButton } from '../ui.js';
import { api } from '../api.js';
import { t, LANGS, setLang } from '../i18n.js';
import { can, go, session, applyBrand, refresh } from '../app.js';

const ROLES = () => [['admin', t('Admin')], ['content', t('Content manager')], ['device', t('Device manager')]];
const roleName = (r) => ({ owner: t('Owner'), admin: t('Admin'), content: t('Content manager'), device: t('Device manager') }[r] || r);

export async function settingsPage(ctx) {
  const { mount } = ctx;
  if (!can('security')) { go('/'); return; }
  const tabName = location.pathname.split('/')[2] || 'general';
  const TABS = [['general', t('General')], ['people', t('People')], ['plugins', t('Plugins')], ['integrations', t('Integrations')], ['activity', t('Activity')]];
  const body = await ({ general, people, plugins, integrations, activity }[tabName] || general)(ctx);
  mount(h('div', {},
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, t('Settings')))),
    h('nav', { class: 'tabs' }, TABS.map(([k, l]) => h('a', { href: `/settings/${k}`, 'data-link': true, class: k === tabName ? 'on' : '' }, l))),
    body));
}

// ---------- general ----------
async function general() {
  const s = await api.get('/settings');
  const save = safely(async (patch) => { await api.patch('/settings', patch); toast(t('Saved')); });
  const name = h('input', { value: s.brandName });
  const logo = h('input', { value: s.brandLogo, placeholder: 'https://…/logo.svg' });
  const accent = h('input', { type: 'color', value: s.accent || '#c8401a' });
  const duration = h('input', { type: 'number', min: 1, value: s.defaultDuration });
  const snippet = h('textarea', { class: 'code', rows: 5, value: s.playerSnippet, disabled: !can('owner'), placeholder: '<script>…</script>' });

  return h('div', { class: 'stack', style: { maxWidth: '720px', gap: '26px' } },
    h('section', { class: 'panel stack' },
      h('h2', { class: 'section-title', style: { margin: 0 } }, t('Your brand')),
      h('div', { class: 'grid2' }, field(t('Studio name'), name), field(t('Logo address'), logo, t('Optional. Replaces the name in the menu.'))),
      field(t('Accent color'), h('div', { class: 'row' }, accent, btn(t('Reset'), safely(async () => {
        await api.patch('/settings', { accent: '' });
        session.brand.accent = '';
        applyBrand();
        toast(t('Saved'));
      }), 'sm ghost'))),
      h('div', {}, btn(t('Save brand'), safely(async () => {
        await api.patch('/settings', { brandName: name.value, brandLogo: logo.value, accent: accent.value });
        Object.assign(session.brand, { name: name.value, logo: logo.value, accent: accent.value });
        applyBrand();
        toast(t('Saved'));
        refresh();
      }), 'primary'))),
    h('section', { class: 'panel stack' },
      h('h2', { class: 'section-title', style: { margin: 0 } }, t('Language')),
      field(t('Default for everyone'), select(LANGS, s.language, (v) => {
        save({ language: v });
        session.language = v;
        if (!session.user.lang) { setLang(v); refresh(); }
      }), t('People can pick their own in Profile.'))),
    h('section', { class: 'panel stack' },
      h('h2', { class: 'section-title', style: { margin: 0 } }, t('Player defaults')),
      h('div', { class: 'grid2' },
        field(t('Default slide duration (seconds)'), duration),
        field(t('Default transition'), select([['fade', t('Fade')], ['slide', t('Slide')], ['zoom', t('Zoom')], ['wipe', t('Wipe')], ['none', t('None')]], s.defaultTransition, (v) => save({ defaultTransition: v })))),
      h('div', {}, btn(t('Save duration'), () => save({ defaultDuration: Number(duration.value) || 10 }))),
      check(t('Allow public player links (/use and /group) without signing in'), s.publicPlayers, (v) => save({ publicPlayers: v })),
      h('p', { class: 'small muted', style: { margin: 0 } }, t('Anyone who has one of those links can watch that playlist. Paired screens do not need this.'))),
    h('section', { class: 'panel stack' },
      h('h2', { class: 'section-title', style: { margin: 0 } }, t('Player code snippet')),
      field(t('Added to every player page'), snippet, can('owner') ? t('For analytics or custom styling. It runs on every screen, so only the owner can edit it.') : t('Only the owner can edit this.')),
      can('owner') && h('div', {}, btn(t('Save snippet'), () => save({ playerSnippet: snippet.value })))),
    can('owner') && h('section', { class: 'panel stack' },
      h('h2', { class: 'section-title', style: { margin: 0 } }, t('Backup')),
      h('p', { class: 'muted', style: { margin: 0 } }, t('Downloads a snapshot of the database. Back up the data/media folder too, as it holds your uploaded files.')),
      h('div', {}, h('a', { class: 'btn', href: '/api/backup', download: true }, t('Download backup')))));
}

// ---------- people ----------
async function people() {
  const [users, teams] = await Promise.all([api.get('/users'), api.get('/teams')]);
  const teamName = (tid) => teams.find((x) => x.id === tid)?.name;
  const teamOptions = [['', t('No team')], ...teams.map((x) => [x.id, x.name])];

  const userDialog = (u) => {
    const username = h('input', { value: u?.username || '', disabled: Boolean(u), autocomplete: 'off' });
    const name = h('input', { value: u?.name || '' });
    const password = h('input', { type: 'password', autocomplete: 'new-password' });
    let role = u?.role || 'content', teamId = u?.teamId || '', active = u ? u.active : true;
    const isOwner = u?.role === 'owner';
    modal({
      title: u ? u.username : t('Add person'),
      body: [
        h('div', { class: 'grid2' }, field(t('Username'), username), field(t('Display name'), name)),
        field(u ? t('New password') : t('Password'), password, u ? t('Leave empty to keep the current one. Changing it signs them out.') : t('At least 8 characters. Ask them to change it after signing in.')),
        h('div', { class: 'grid2' },
          !isOwner && field(t('Role'), select(ROLES(), role, (v) => { role = v; })),
          field(t('Team'), select(teamOptions, teamId, (v) => { teamId = v; }))),
        !isOwner && u && check(t('Account active'), active, (v) => { active = v; }),
      ],
      foot: (close) => [
        u && !isOwner && u.id !== session.user.id && h('div', { class: 'left' }, btn(t('Delete'), safely(async () => {
          if (!await confirmDialog(t('Delete "{name}"?', { name: u.username }), t('Their content stays in place.'))) return;
          await api.del(`/users/${u.id}`);
          close(); refresh();
        }), 'danger')),
        btn(t('Cancel'), close),
        btn(t('Save'), safely(async () => {
          if (u) await api.patch(`/users/${u.id}`, { name: name.value, teamId, ...(isOwner ? {} : { role, active }), ...(password.value ? { password: password.value } : {}) });
          else await api.post('/users', { username: username.value, name: name.value, password: password.value, role, teamId });
          close(); toast(t('Saved')); refresh();
        }), 'primary'),
      ],
    });
  };

  const teamInput = h('input', { placeholder: t('Marketing'), 'aria-label': t('Team name') });
  return h('div', { class: 'stack', style: { gap: '30px' } },
    h('section', {},
      h('div', { class: 'row between', style: { marginBottom: '10px' } }, h('h2', { class: 'section-title', style: { margin: 0 } }, t('People')), btn(t('Add person'), () => userDialog(), 'primary', 'plus')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, t('Name')), h('th', {}, t('Role')), h('th', {}, t('Team')), h('th', {}, t('Two-factor')), h('th', {}, t('Last sign-in')), h('th', {}))),
        h('tbody', {}, users.map((u) => h('tr', { style: { opacity: u.active ? 1 : 0.5 } },
          h('td', {}, h('div', { style: { fontWeight: 600 } }, u.name || u.username), h('div', { class: 'small muted' }, u.username)),
          h('td', { class: 'nowrap' }, roleName(u.role)),
          h('td', {}, teamName(u.teamId) || h('span', { class: 'muted' }, '–')),
          h('td', {}, u.totpEnabled ? h('span', { class: 'chip live' }, t('On')) : h('span', { class: 'chip' }, t('Off'))),
          h('td', { class: 'nowrap small' }, timeAgo(u.lastLogin)),
          h('td', { class: 'num' }, (u.role !== 'owner' || can('owner')) && btn(t('Edit'), () => userDialog(u), 'sm')))))))),
    h('section', { style: { maxWidth: '560px' } },
      h('h2', { class: 'section-title' }, t('Teams')),
      h('p', { class: 'small muted', style: { marginTop: 0 } }, t('People in a team see only their team\'s content, playlists and screens, plus anything with no team. People with no team see everything.')),
      teams.map((x) => h('div', { class: 'plugin-row' }, h('div', { class: 'grow' }, h('b', {}, x.name), h('span', { class: 'muted small' }, ` · ${t('{n} people', { n: x.members })}`)),
        iconBtn('trash', t('Delete team'), safely(async () => {
          if (!await confirmDialog(t('Delete team "{name}"?', { name: x.name }), t('Its members and items stay, with no team.'))) return;
          await api.del(`/teams/${x.id}`);
          refresh();
        })))),
      h('form', {
        class: 'row', style: { marginTop: '12px', flexWrap: 'nowrap' },
        onsubmit: safely(async (e) => { e.preventDefault(); await api.post('/teams', { name: teamInput.value }); refresh(); }),
      }, teamInput, h('button', { class: 'btn', type: 'submit' }, t('Add team')))));
}

// ---------- plugins ----------
async function plugins() {
  const list = await api.get('/plugins');
  const row = (p) => h('div', { class: 'plugin-row' },
    switchEl(p.enabled, safely(async (v) => {
      await api.post(`/plugins/${encodeURIComponent(p.id)}/toggle`, { enabled: v });
      toast(v ? t('Turned on') : t('Turned off'));
    }), p.name),
    h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, p.name, p.version && h('span', { class: 'muted small mono' }, ` v${p.version}`)), h('div', { class: 'small muted' }, p.description)));
  return h('div', { class: 'stack', style: { maxWidth: '720px', gap: '26px' } },
    h('section', {}, h('h2', { class: 'section-title' }, t('Installed plugins')),
      h('p', { class: 'small muted', style: { marginTop: 0 } }, t('Add more by placing a folder in plugins/ and restarting. See plugins/README.md.')),
      list.filter((p) => !p.core).map(row)),
    h('section', {}, h('h2', { class: 'section-title' }, t('Built-in content types')),
      h('p', { class: 'small muted', style: { marginTop: 0 } }, t('Turning one off hides it and stops it playing. Existing items are kept.')),
      list.filter((p) => p.core).map(row)));
}

// ---------- integrations ----------
const HOOK_EVENTS = ['screen.online', 'screen.offline', 'screen.paired', 'content.created', 'content.updated', 'content.deleted', 'playlist.updated', 'broadcast.started', 'broadcast.ended'];
async function integrations() {
  const [hooks, tokens, spec] = await Promise.all([api.get('/webhooks'), api.get('/me/tokens'), api.get('/openapi.json')]);
  const tokenName = h('input', { placeholder: t('Automation server'), 'aria-label': t('Token name') });
  const hookUrl = h('input', { type: 'url', placeholder: 'https://n8n.example.com/webhook/…', 'aria-label': t('Webhook address') });
  const chosen = new Set();
  const endpoints = Object.entries(spec.paths).flatMap(([p, ms]) => Object.entries(ms).map(([m, op]) => ({ p, m, op })));
  const tags = [...new Set(endpoints.map((e) => e.op.tags[0]))];

  return h('div', { class: 'stack', style: { gap: '30px', maxWidth: '860px' } },
    h('section', {},
      h('h2', { class: 'section-title' }, t('API tokens')),
      h('p', { class: 'small muted', style: { marginTop: 0 } }, t('A token acts with your permissions. Send it as: Authorization: Bearer <token>')),
      tokens.map((k) => h('div', { class: 'plugin-row' }, h('div', { class: 'grow' }, h('b', {}, k.name), h('div', { class: 'small muted mono' }, `${k.prefix}… · ${t('last used')} ${timeAgo(k.lastUsed)}`)),
        btn(t('Revoke'), safely(async () => { await api.del(`/me/tokens/${k.id}`); refresh(); }), 'sm danger'))),
      h('form', {
        class: 'row', style: { marginTop: '12px', flexWrap: 'nowrap' },
        onsubmit: safely(async (e) => {
          e.preventDefault();
          const r = await api.post('/me/tokens', { name: tokenName.value });
          modal({
            title: t('Copy your token now'), onClose: refresh,
            body: [h('p', { style: { margin: 0 } }, t('It will not be shown again.')), h('div', { class: 'code-block' }, r.token), h('div', {}, copyButton(r.token))],
          });
        }),
      }, tokenName, h('button', { class: 'btn', type: 'submit' }, t('Create token')))),
    h('section', {},
      h('h2', { class: 'section-title' }, t('Webhooks')),
      h('p', { class: 'small muted', style: { marginTop: 0 } }, t('Vitrine POSTs JSON when something happens, signed in the X-Vitrine-Signature header. Works with n8n, Zapier, Make, or your own service.')),
      hooks.map((w) => h('div', { class: 'plugin-row', style: { flexWrap: 'wrap' } },
        h('div', { class: 'grow', style: { minWidth: '220px' } },
          h('div', { class: 'clip', style: { fontWeight: 600 } }, w.url),
          h('div', { class: 'small muted' }, w.events.join(', ')),
          h('div', { class: 'small muted mono clip' }, `${t('Secret:')} ${w.secret}`),
          w.lastStatus && h('div', { class: 'small muted' }, `${t('Last delivery:')} ${w.lastStatus} · ${timeAgo(w.lastAt)}`)),
        btn(t('Send test'), safely(async () => { const r = await api.post(`/webhooks/${w.id}/test`); toast(`${t('Response:')} ${r.status}`, !/^2/.test(r.status)); refresh(); }), 'sm'),
        iconBtn('trash', t('Delete webhook'), safely(async () => { await api.del(`/webhooks/${w.id}`); refresh(); })))),
      h('form', {
        class: 'stack', style: { marginTop: '12px' },
        onsubmit: safely(async (e) => { e.preventDefault(); await api.post('/webhooks', { url: hookUrl.value, events: [...chosen] }); refresh(); }),
      }, hookUrl,
      h('div', { class: 'row' }, HOOK_EVENTS.map((ev) => check(ev, false, (v) => { if (v) chosen.add(ev); else chosen.delete(ev); }))),
      h('p', { class: 'small muted', style: { margin: 0 } }, t('Choose none to receive every event.')),
      h('div', {}, h('button', { class: 'btn', type: 'submit' }, t('Add webhook'))))),
    h('section', {},
      h('div', { class: 'row between' }, h('h2', { class: 'section-title' }, t('REST API reference')), h('a', { class: 'btn sm', href: '/api/openapi.json', target: '_blank' }, 'OpenAPI JSON')),
      tags.map((tag) => h('details', { style: { borderBottom: '1px solid var(--hair)', padding: '8px 0' } },
        h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, tag),
        h('div', { style: { marginTop: '8px' } }, endpoints.filter((e) => e.op.tags[0] === tag).map((e) => h('div', { class: 'row small', style: { padding: '3px 0', flexWrap: 'nowrap', alignItems: 'baseline' } },
          h('span', { class: 'method' }, e.m), h('code', { class: 'mono nowrap' }, `/api${e.p}`), h('span', { class: 'muted clip' }, e.op.summary))))))));
}

// ---------- activity ----------
async function activity() {
  const rows = await api.get('/audit?limit=200');
  if (!rows.length) return empty(t('No activity yet'), t('Changes people make are recorded here.'));
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, t('When')), h('th', {}, t('Who')), h('th', {}, t('Action')), h('th', {}, t('Item')), h('th', {}, t('Address')))),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', { class: 'nowrap small' }, new Date(r.at).toLocaleString()),
      h('td', {}, r.username || t('System')),
      h('td', { class: 'mono' }, r.action),
      h('td', {}, r.entity),
      h('td', { class: 'mono muted' }, r.ip))))));
}
