import { h, segmented, select, empty, formatDuration, tooltip } from '../ui.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

let days = 7;
let screenId = '';
let view = 'chart';

function dayChart(rows) {
  // Fill gaps so the x-axis stays true to time.
  const map = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    out.push(map.get(d) || { day: d, plays: 0, seconds: 0 });
  }
  const max = Math.max(...out.map((r) => r.plays), 1);
  const fmt = (d) => new Date(`${d}T12:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return h('div', {},
    h('div', { class: 'chart-day' }, out.map((r) => {
      const col = h('div', { class: 'col', tabindex: 0, 'aria-label': `${fmt(r.day)}: ${t('{n} plays', { n: r.plays })}` },
        r.plays > 0 && h('i', { style: { height: `${(r.plays / max) * 100}%` } }));
      tooltip(col, `${fmt(r.day)} · ${t('{n} plays', { n: r.plays })} · ${formatDuration(r.seconds)}`);
      return col;
    })),
    h('div', { class: 'axis' }, h('span', {}, fmt(out[0].day)), h('span', {}, `${t('Peak')}: ${max}`), h('span', {}, fmt(out[out.length - 1].day))));
}

function bars(rows) {
  const max = Math.max(...rows.map((r) => r.plays), 1);
  return h('div', {}, rows.map((r) => {
    const row = h('div', { class: 'hbar' },
      h('div', { class: 'clip' }, r.name || t('Unnamed')),
      h('div', { class: 'track' }, h('i', { style: { width: `${(r.plays / max) * 100}%` } })),
      h('div', { class: 'v' }, r.plays));
    tooltip(row, `${t('{n} plays', { n: r.plays })} · ${formatDuration(r.seconds)}`);
    return row;
  }));
}

const table = (rows, first) => h('div', { class: 'table-wrap' }, h('table', {},
  h('thead', {}, h('tr', {}, h('th', {}, first), h('th', { class: 'num' }, t('Plays')), h('th', { class: 'num' }, t('Time on screen')))),
  h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.name || r.day), h('td', { class: 'num' }, r.plays), h('td', { class: 'num' }, formatDuration(r.seconds)))))));

export async function insightsPage({ mount, isCurrent }) {
  const screens = await api.get('/screens');
  const load = async () => {
    const q = `days=${days}${screenId ? `&screenId=${screenId}` : ''}`;
    const d = await api.get(`/insights?${q}`);
    if (!isCurrent()) return;
    const tile = (v, label) => h('div', { class: 'stat' }, h('b', {}, v), h('span', { class: 'small muted' }, label));
    const chart = view === 'chart';
    mount(h('div', {},
      h('header', { class: 'page-head' },
        h('div', {}, h('h1', {}, t('Insights')), h('div', { class: 'sub' }, t('Proof of play: what actually ran, and where.'))),
        h('div', { class: 'actions' }, h('a', { class: 'btn', href: `/api/insights/export.csv?${q}`, download: true }, t('Export CSV')))),
      h('div', { class: 'toolbar' },
        segmented([[7, t('7 days')], [30, t('30 days')], [90, t('90 days')]], days, (v) => { days = v; load(); }),
        h('div', { style: { width: '200px' } }, select([['', t('All screens')], ...screens.map((s) => [s.id, s.name])], screenId, (v) => { screenId = v; load(); })),
        h('div', { style: { marginLeft: 'auto' } }, segmented([['chart', t('Charts')], ['table', t('Tables')]], view, (v) => { view = v; load(); }))),
      d.totals.plays === 0
        ? empty(t('No plays in this period'), t('Paired screens report each item they play. Numbers appear once a screen has been running.'))
        : h('div', {},
          h('div', { class: 'stat-row' },
            tile(d.totals.plays.toLocaleString(), t('Plays')),
            tile(formatDuration(d.totals.seconds), t('Time on screen')),
            tile(d.totals.screens, t('Screens reporting')),
            tile(d.totals.items, t('Different items'))),
          h('section', { style: { marginBottom: '30px' } }, h('h2', { class: 'section-title' }, t('Plays per day')), chart ? dayChart(d.byDay) : table(d.byDay, t('Day'))),
          h('div', { class: 'grid2', style: { gap: '32px' } },
            h('section', {}, h('h2', { class: 'section-title' }, t('Most played')), chart ? bars(d.byContent) : table(d.byContent, t('Item'))),
            h('section', {}, h('h2', { class: 'section-title' }, t('By screen')), chart ? bars(d.byScreen) : table(d.byScreen, t('Screen')))))));
  };
  await load();
}
