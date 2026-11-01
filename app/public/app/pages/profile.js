import { h, btn, modal, toast, safely, field, select } from '../ui.js';
import { api } from '../api.js';
import { t, LANGS, setLang } from '../i18n.js';
import { session, refresh } from '../app.js';

export async function profilePage({ mount }) {
  const u = session.user;
  const name = h('input', { value: u.name || '' });
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });

  const startTotp = safely(async () => {
    const r = await api.post('/me/totp/start');
    const code = h('input', { inputmode: 'numeric', maxlength: 6, placeholder: '123456' });
    modal({
      title: t('Turn on two-factor'),
      body: [
        h('p', { style: { margin: 0 } }, t('Scan this with an authenticator app, then enter the code it shows.')),
        h('div', { class: 'qr', html: r.qr }),
        h('div', { class: 'small muted' }, t('Cannot scan? Enter this key:')), h('div', { class: 'code-block' }, r.secret),
        field(t('Code'), code),
      ],
      foot: (close) => [btn(t('Cancel'), close), btn(t('Turn on'), safely(async () => {
        await api.post('/me/totp/confirm', { code: code.value });
        session.user.totpEnabled = true;
        close(); toast(t('Two-factor is on')); refresh();
      }), 'primary')],
    });
  });

  const stopTotp = () => {
    const pw = h('input', { type: 'password', autocomplete: 'current-password' });
    modal({
      title: t('Turn off two-factor'),
      body: field(t('Current password'), pw),
      foot: (close) => [btn(t('Cancel'), close), btn(t('Turn off'), safely(async () => {
        await api.post('/me/totp/disable', { password: pw.value });
        session.user.totpEnabled = false;
        close(); toast(t('Two-factor is off')); refresh();
      }), 'danger')],
    });
  };

  mount(h('div', {},
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, t('Profile')), h('div', { class: 'sub' }, `${u.username} · ${u.role}`)),
      h('div', { class: 'actions' }, btn(t('Sign out'), safely(async () => {
        await api.post('/auth/logout');
        location.href = '/';
      })))),
    h('div', { class: 'stack', style: { maxWidth: '560px', gap: '24px' } },
      h('section', { class: 'panel stack' },
        field(t('Display name'), name),
        field(t('Language'), select([['', t('Studio default')], ...LANGS], u.lang || '', safely(async (v) => {
          const r = await api.patch('/me', { lang: v });
          session.user = r.user;
          setLang(v || session.language);
          refresh();
        }))),
        h('div', {}, btn(t('Save'), safely(async () => {
          const r = await api.patch('/me', { name: name.value });
          session.user = r.user;
          toast(t('Saved'));
          refresh();
        }), 'primary'))),
      h('section', { class: 'panel stack' },
        h('h2', { class: 'section-title', style: { margin: 0 } }, t('Password')),
        field(t('Current password'), current), field(t('New password'), next, t('At least 8 characters.')),
        h('div', {}, btn(t('Change password'), safely(async () => {
          await api.patch('/me', { currentPassword: current.value, password: next.value });
          current.value = ''; next.value = '';
          toast(t('Password changed'));
        })))),
      h('section', { class: 'panel stack' },
        h('h2', { class: 'section-title', style: { margin: 0 } }, t('Two-factor sign-in')),
        h('p', { class: 'muted', style: { margin: 0 } }, u.totpEnabled ? t('On. Signing in asks for a code from your authenticator app.') : t('Off. Add a code from an authenticator app to protect your account.')),
        h('div', {}, u.totpEnabled ? btn(t('Turn off'), stopTotp, 'danger') : btn(t('Turn on'), startTotp))))));
}
