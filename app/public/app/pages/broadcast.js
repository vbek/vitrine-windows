import { h, btn, toast, safely, confirmDialog, field, select, segmented, check, timeAgo, empty } from '../ui.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { can, refresh } from '../app.js';

export async function broadcastPage({ mount, isCurrent }) {
  const [history, screens, groups] = await Promise.all([api.get('/broadcasts'), api.get('/screens'), api.get('/groups')]);
  if (!isCurrent()) return;
  const allowed = can('content') || can('device');
  const b = { title: '', message: '', style: 'alert', layout: 'full', minutes: 30, targets: { all: true, groups: [], screens: [] } };
  const preview = h('div', { class: 'bc-preview', 'aria-label': t('Preview') });

  const draw = () => {
    preview.replaceChildren(h('div', { class: `bcp ${b.style} ${b.layout}` }, b.title && h('b', {}, b.title), h('span', {}, b.message || t('Your message appears here'))));
  };
  draw();

  const targetBox = h('div', { class: 'stack hide' },
    groups.length > 0 && h('div', { class: 'row' }, groups.map((g) => check(g.name, false, (v) => { toggle(b.targets.groups, g.id, v); }))),
    screens.length > 0 && h('div', { class: 'row' }, screens.map((s) => check(s.name, false, (v) => { toggle(b.targets.screens, s.id, v); }))),
    !groups.length && !screens.length && h('p', { class: 'small muted', style: { margin: 0 } }, t('No screens yet.')));
  const toggle = (arr, id, on) => { const i = arr.indexOf(id); if (on && i < 0) arr.push(id); if (!on && i >= 0) arr.splice(i, 1); };

  const now = new Date();
  const isLive = (x) => !x.endedAt && (!x.expiresAt || new Date(x.expiresAt) > now);
  const active = history.filter(isLive);
  const past = history.filter((x) => !isLive(x)).slice(0, 15);
  const audience = (x) => (x.targets.all ? t('All screens') : t('{n} targets', { n: (x.targets.groups?.length || 0) + (x.targets.screens?.length || 0) }));

  mount(h('div', {},
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, t('Broadcast')), h('div', { class: 'sub' }, t('Interrupt screens straight away, for emergencies and urgent notices.')))),
    active.map((x) => h('div', { class: 'alert-bar', role: 'status' },
      h('b', {}, t('On air now:')),
      h('span', { class: 'grow' }, `${x.title ? `${x.title}: ` : ''}${x.message} · ${audience(x)}`),
      allowed && btn(t('End broadcast'), safely(async () => { await api.post(`/broadcasts/${x.id}/end`); toast(t('Broadcast ended')); refresh(); }), 'sm'))),
    h('div', { class: 'two-col', style: { gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' } },
      allowed ? h('section', { class: 'stack' },
        field(t('Heading'), h('input', { placeholder: t('Fire drill'), value: b.title, oninput: (e) => { b.title = e.target.value; draw(); } })),
        field(t('Message'), h('textarea', { rows: 3, placeholder: t('Please leave by the nearest exit.'), oninput: (e) => { b.message = e.target.value; draw(); } })),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('div', { class: 'label' }, t('Urgency')), segmented([['alert', t('Alert')], ['warning', t('Warning')], ['info', t('Notice')]], b.style, (v) => { b.style = v; draw(); })),
          h('div', { class: 'field' }, h('div', { class: 'label' }, t('Takes over')), segmented([['full', t('Full screen')], ['banner', t('Banner')]], b.layout, (v) => { b.layout = v; draw(); }))),
        field(t('Ends after'), select([[15, t('15 minutes')], [30, t('30 minutes')], [60, t('1 hour')], [240, t('4 hours')], [1440, t('1 day')], [0, t('Until I end it')]], b.minutes, (v) => { b.minutes = Number(v); })),
        h('div', { class: 'field' }, h('div', { class: 'label' }, t('Show on')),
          segmented([['all', t('All screens')], ['some', t('Choose')]], 'all', (v) => { b.targets.all = v === 'all'; targetBox.classList.toggle('hide', v === 'all'); })),
        targetBox,
        h('div', {}, btn(t('Go on air'), safely(async () => {
          if (!b.message.trim()) throw new Error(t('Write a message first'));
          if (!b.targets.all && !b.targets.groups.length && !b.targets.screens.length) throw new Error(t('Choose at least one screen or group'));
          const where = b.targets.all ? t('all screens') : audience(b);
          if (!await confirmDialog(t('Go on air?'), t('This interrupts {where} immediately.', { where }), { action: t('Go on air') })) return;
          await api.post('/broadcasts', b);
          toast(t('On air'));
          refresh();
        }), 'primary', 'broadcast'))) : h('p', { class: 'muted' }, t('You do not have permission to broadcast.')),
      h('section', { class: 'stack' }, h('div', { class: 'kicker' }, t('Preview')), preview)),
    h('section', { style: { marginTop: '34px' } },
      h('h2', { class: 'section-title' }, t('History')),
      past.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, t('Message')), h('th', {}, t('Sent to')), h('th', {}, t('Sent by')), h('th', {}, t('When')))),
        h('tbody', {}, past.map((x) => h('tr', {},
          h('td', {}, x.title ? h('b', {}, `${x.title}: `) : null, x.message), h('td', { class: 'nowrap' }, audience(x)), h('td', {}, x.createdBy), h('td', { class: 'nowrap' }, timeAgo(x.createdAt))))))) : empty(t('Nothing sent yet'), t('Past broadcasts are listed here.')))));
}
