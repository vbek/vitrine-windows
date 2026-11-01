import { h, icon, btn, iconBtn, modal, toast, safely, confirmDialog, prompt1, empty, field, select, switchEl, segmented, dayPicker, contentThumb, formatDuration, scheduleSummary, typeLabel, DAYS } from '../ui.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { can, go, screenOrigin } from '../app.js';
import { openPreview, uploadFiles } from './library.js';

export async function playlistsPage({ mount, isCurrent }) {
  const list = await api.get('/playlists');
  if (!isCurrent()) return;
  const create = safely(async () => {
    const name = await prompt1(t('New playlist'), t('Name'), '', t('Create'));
    if (!name) return;
    const p = await api.post('/playlists', { name });
    go(`/playlists/${p.id}`);
  });
  mount(h('div', {},
    h('header', { class: 'page-head' },
      h('div', {}, h('h1', {}, t('Playlists')), h('div', { class: 'sub' }, t('The running order for your screens.'))),
      h('div', { class: 'actions' }, can('content') && btn(t('New playlist'), create, 'primary', 'plus'))),
    list.length
      ? h('div', { class: 'pl-grid' }, list.map((p) => h('a', { class: 'pl-card', href: `/playlists/${p.id}`, 'data-link': true },
        h('div', { class: 'collage' }, p.covers.length ? p.covers.map((c) => h('img', { src: c, alt: '', loading: 'lazy' })) : h('div', { class: 'none' }, icon('playlist'))),
        h('div', { class: 'body' },
          h('h3', { class: 'clip' }, p.name),
          h('div', { class: 'small muted' }, `${t('{n} slides', { n: p.slideCount })} · ${formatDuration(p.totalDuration)}`),
          h('div', { class: 'row', style: { marginTop: '6px' } }, p.screens ? h('span', { class: 'chip live' }, t('On {n} screens', { n: p.screens })) : h('span', { class: 'chip' }, t('Not on a screen')))))))
      : empty(t('No playlists yet'), t('A playlist is an ordered set of content with timing and schedules.'), can('content') && btn(t('New playlist'), create, 'primary', 'plus'))));
}

// ---------- schedule dialog ----------
function scheduleDialog(slide, onSave) {
  const s = { mode: 'always', ...structuredClone(slide.schedule) };
  const area = h('div', { class: 'stack' });
  const days = DAYS();
  const dayOptions = days.map((d, i) => [i, d]);

  function draw() {
    area.replaceChildren();
    if (s.mode === 'always') area.append(h('p', { class: 'muted', style: { margin: 0 } }, t('Plays every time the playlist comes round.')));
    if (s.mode === 'dates') {
      area.append(h('div', { class: 'grid2' },
        field(t('Starts'), h('input', { type: 'datetime-local', value: s.start || '', onchange: (e) => { s.start = e.target.value; } }), t('Leave empty to start now.')),
        field(t('Ends'), h('input', { type: 'datetime-local', value: s.end || '', onchange: (e) => { s.end = e.target.value; } }), t('Leave empty to keep playing.'))));
    }
    if (s.mode === 'week') {
      s.startDay ??= 0; s.endDay ??= 4; s.startTime ||= '09:00'; s.endTime ||= '17:00';
      area.append(
        h('div', { class: 'grid2' },
          field(t('From'), select(dayOptions, s.startDay, (v) => { s.startDay = Number(v); })),
          field(t('At'), h('input', { type: 'time', value: s.startTime, onchange: (e) => { s.startTime = e.target.value; } }))),
        h('div', { class: 'grid2' },
          field(t('Until'), select(dayOptions, s.endDay, (v) => { s.endDay = Number(v); })),
          field(t('At'), h('input', { type: 'time', value: s.endTime, onchange: (e) => { s.endTime = e.target.value; } }))),
        h('p', { class: 'small muted', style: { margin: 0 } }, t('One continuous stretch each week. It can run over the weekend, like Friday evening to Monday morning.')));
    }
    if (s.mode === 'daily') {
      s.days ??= [0, 1, 2, 3, 4]; s.from ||= '09:00'; s.to ||= '17:00';
      area.append(
        h('div', { class: 'field' }, h('div', { class: 'label' }, t('On these days')), dayPicker(s.days, (v) => { s.days = v; })),
        h('div', { class: 'grid2' },
          field(t('From'), h('input', { type: 'time', value: s.from, onchange: (e) => { s.from = e.target.value; } })),
          field(t('Until'), h('input', { type: 'time', value: s.to, onchange: (e) => { s.to = e.target.value; } }))),
        h('p', { class: 'small muted', style: { margin: 0 } }, t('The same hours on each chosen day. An end earlier than the start runs past midnight.')));
    }
  }
  draw();
  modal({
    title: t('When does it play?'),
    body: [segmented([['always', t('Always')], ['dates', t('Dates')], ['daily', t('Daily hours')], ['week', t('Weekly')]], s.mode, (v) => { s.mode = v; draw(); }), area,
      h('p', { class: 'small muted', style: { margin: 0 } }, t('Times use each screen\'s own clock.'))],
    foot: (close) => [btn(t('Cancel'), close), btn(t('Save'), safely(async () => { await onSave(s); close(); }), 'primary')],
  });
}

// ---------- add content picker ----------
async function pickerDialog(playlist, onDone) {
  const [content, playlists, types] = await Promise.all([api.get('/content'), api.get('/playlists'), api.get('/content-types')]);
  const chosen = new Set();
  let q = '';
  const grid = h('div');
  const count = h('span', { class: 'muted small' });
  const addBtn = h('button', { class: 'btn primary', type: 'button' }, t('Add'));

  const draw = () => {
    const list = content.filter((c) => c.name.toLowerCase().includes(q));
    grid.replaceChildren(list.length ? h('div', { class: 'items' }, list.map((c) => {
      const n = h('article', { class: `item ${chosen.has(c.id) ? 'sel' : ''}` },
        h('button', {
          class: 'open', type: 'button', 'aria-pressed': String(chosen.has(c.id)),
          onclick: () => {
            if (chosen.has(c.id)) chosen.delete(c.id); else chosen.add(c.id);
            n.classList.toggle('sel', chosen.has(c.id));
            count.textContent = chosen.size ? t('{n} selected', { n: chosen.size }) : '';
          },
        }, contentThumb(c), h('div', { class: 'name clip' }, c.name), h('div', { class: 'meta' }, typeLabel(c.type))));
      return n;
    })) : empty(t('Nothing here yet'), t('Upload something below, or add it in the library.')));
  };
  draw();

  const others = playlists.filter((p) => p.id !== playlist.id);
  modal({
    title: t('Add to {name}', { name: playlist.name }), wide: true,
    body: [
      h('div', { class: 'toolbar', style: { marginBottom: 0 } },
        h('input', { class: 'search', type: 'search', placeholder: t('Search'), 'aria-label': t('Search'), oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }),
        h('label', { class: 'btn' }, icon('upload'), t('Upload'), h('input', {
          type: 'file', multiple: true, class: 'hide', accept: 'image/*,video/*,application/pdf',
          onchange: safely(async (e) => {
            const made = await uploadFiles([...e.target.files]);
            content.unshift(...made);
            made.forEach((m) => chosen.add(m.id));
            count.textContent = t('{n} selected', { n: chosen.size });
            draw();
          }),
        }))),
      grid,
      types.core.includes('embed') && others.length > 0 && h('div', { class: 'stack' },
        h('div', { class: 'kicker' }, t('Or include a whole playlist')),
        h('div', { class: 'row' }, others.map((p) => btn(p.name, safely(async () => {
          await api.post(`/playlists/${playlist.id}/slides`, { embedPlaylistId: p.id });
          toast(t('Added'));
          onDone();
        }), 'sm', 'embed')))),
    ],
    foot: (close) => {
      addBtn.onclick = safely(async () => {
        if (chosen.size) await api.post(`/playlists/${playlist.id}/slides`, { items: [...chosen].map((contentId) => ({ contentId })) });
        close(); onDone();
      });
      return [h('div', { class: 'left' }, count), btn(t('Cancel'), close), addBtn];
    },
  });
}

// ---------- editor ----------
export async function playlistEditor({ mount, isCurrent }, id) {
  let pl = await api.get(`/playlists/${id}`);
  await import('/vendor/Sortable.min.js');
  if (!isCurrent()) return;
  const editable = can('content');
  const list = h('ol', { class: 'slides' });
  const timeline = h('div', { class: 'timeline', 'aria-hidden': 'true' });
  const summary = h('span', { class: 'muted small' });
  const previewBox = h('div', { class: 'window' }, h('iframe', { src: `/preview?playlist=${id}&intro=0`, title: t('Preview'), allow: 'autoplay' }));
  const reload = async () => { pl = await api.get(`/playlists/${id}`); draw(); };

  function drawTimeline() {
    const live = pl.slides.filter((s) => s.enabled);
    const total = live.reduce((a, s) => a + (s.duration || s.content?.duration || 10), 0);
    summary.textContent = `${t('{n} slides', { n: pl.slides.length })} · ${formatDuration(total)}`;
    timeline.replaceChildren(...live.map((s) => h('i', { class: s.schedule?.mode !== 'always' ? 'sched' : '', style: { flex: `${s.duration || s.content?.duration || 10} 1 0` } })));
  }

  function slideRow(s) {
    const video = s.content?.type === 'video';
    const summaryText = scheduleSummary(s.schedule);
    const row = h('li', { class: `slide ${s.enabled ? '' : 'off'}`, 'data-id': s.id },
      h('div', { class: 'grab', 'aria-label': t('Drag to reorder') }, icon('grip')),
      h('div', { class: 'idx' }),
      s.embed ? h('div', { class: 'window' }, icon('embed')) : contentThumb(s.content),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'clip', style: { fontWeight: 600 } }, s.embed ? s.embed.name : s.content?.name),
        h('div', { class: 'row small muted', style: { gap: '6px' } },
          s.embed ? t('Playlist') : typeLabel(s.content?.type),
          editable && !s.embed
            ? h('button', { class: 'chip ' + (summaryText ? 'accent' : ''), type: 'button', style: { border: 0, cursor: 'pointer' }, onclick: () => scheduleDialog(s, async (sc) => { await api.patch(`/slides/${s.id}`, { schedule: sc }); reload(); }) }, icon('clock'), summaryText || t('Always'))
            : summaryText && h('span', { class: 'chip accent' }, summaryText))),
      h('div', { class: 'ctl' },
        !s.embed && h('label', { class: 'row small muted', style: { gap: '4px', flexWrap: 'nowrap' }, title: video ? t('0 plays the whole video') : '' },
          h('input', {
            class: 'dur', type: 'number', min: 0, step: 1, value: s.duration, disabled: !editable, 'aria-label': t('Seconds on screen'),
            onchange: safely(async (e) => { s.duration = Number(e.target.value); await api.patch(`/slides/${s.id}`, { duration: s.duration }); drawTimeline(); }),
          }), video && !s.duration ? t('full') : t('sec')),
        editable && switchEl(s.enabled, safely(async (v) => { await api.patch(`/slides/${s.id}`, { enabled: v }); s.enabled = v; row.classList.toggle('off', !v); drawTimeline(); }), t('Show this slide')),
        editable && iconBtn('trash', t('Remove from playlist'), safely(async () => { await api.del(`/slides/${s.id}`); reload(); }))));
    return row;
  }

  function draw() {
    list.replaceChildren(...pl.slides.map(slideRow));
    drawTimeline();
    emptyNote.classList.toggle('hide', pl.slides.length > 0);
  }
  const emptyNote = empty(t('This playlist is empty'), t('Add pictures, videos, or anything else from your library.'), editable && btn(t('Add content'), () => pickerDialog(pl, reload), 'primary', 'plus'));

  if (editable) {
    window.Sortable.create(list, {
      handle: '.grab', animation: 150, ghostClass: 'sortable-ghost',
      onEnd: safely(async () => {
        const order = [...list.children].map((n) => n.dataset.id);
        await api.patch(`/playlists/${id}/order`, { order });
        pl.slides.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        drawTimeline();
      }),
    });
  }

  const set = { transition: '', speed: 'normal', direction: 'left', loop: 0, ...pl.settings };
  const saveSet = safely(async () => { await api.patch(`/playlists/${id}`, { settings: set }); });
  const directionField = field(t('Direction'), select([['left', t('Left')], ['right', t('Right')], ['up', t('Up')], ['down', t('Down')]], set.direction, (v) => { set.direction = v; saveSet(); }));
  directionField.classList.toggle('hide', set.transition !== 'slide');

  const url = `${screenOrigin()}/use/${id}`;
  draw();

  mount(h('div', {},
    h('a', { class: 'back', href: '/playlists', 'data-link': true, style: { marginTop: '20px' } }, icon('back'), t('Playlists')),
    h('header', { class: 'page-head', style: { paddingTop: '4px' } },
      h('div', { class: 'grow' }, h('h1', { class: 'clip' }, pl.name), h('div', { class: 'sub' }, summary)),
      h('div', { class: 'actions' },
        editable && btn(t('Rename'), safely(async () => {
          const name = await prompt1(t('Rename playlist'), t('Name'), pl.name);
          if (name) { await api.patch(`/playlists/${id}`, { name }); pl.name = name; go(`/playlists/${id}`); }
        })),
        editable && btn(t('Duplicate'), safely(async () => { const c = await api.post(`/playlists/${id}/duplicate`); go(`/playlists/${c.id}`); })),
        editable && btn(t('Delete'), safely(async () => {
          if (!await confirmDialog(t('Delete "{name}"?', { name: pl.name }), t('Screens using it will stop showing it. Your library items stay.'))) return;
          await api.del(`/playlists/${id}`);
          go('/playlists');
        }), 'danger'),
        editable && btn(t('Add content'), () => pickerDialog(pl, reload), 'primary', 'plus'))),
    h('div', { class: 'editor' },
      h('section', {}, timeline, list, emptyNote),
      h('aside', {},
        h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('div', { class: 'kicker' }, t('Live preview')), btn(t('Fullscreen'), () => openPreview(pl.name, `playlist=${id}&intro=0`), 'sm ghost', 'external')), previewBox),
        h('div', { class: 'panel stack' },
          h('div', { class: 'kicker' }, t('Playback')),
          field(t('Transition'), select([['', t('Use default')], ['fade', t('Fade')], ['slide', t('Slide')], ['zoom', t('Zoom')], ['wipe', t('Wipe')], ['none', t('None')]], set.transition, (v) => { set.transition = v; directionField.classList.toggle('hide', v !== 'slide'); saveSet(); })),
          h('div', { class: 'grid2' },
            field(t('Speed'), select([['slow', t('Slow')], ['normal', t('Normal')], ['fast', t('Fast')]], set.speed, (v) => { set.speed = v; saveSet(); })),
            directionField),
          field(t('Times to repeat'), h('input', { type: 'number', min: 0, value: set.loop, onchange: (e) => { set.loop = Number(e.target.value); saveSet(); } }), t('0 repeats forever.')),
          h('div', { class: 'field' }, h('div', { class: 'label' }, t('Direct link')), h('div', { class: 'code-block' }, url), h('div', { class: 'hint' }, t('Works when public player links are on in Settings.'))))))));
}
