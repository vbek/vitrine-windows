import QRCode from 'qrcode';

const safeColor = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => `&#${m.charCodeAt(0)};`);

export async function render(_type, cfg) {
  const bg = safeColor(cfg.bg, '#ffffff');
  const fg = safeColor(cfg.color, '#111111');
  const svg = cfg.url ? await QRCode.toString(String(cfg.url), { type: 'svg', margin: 1, color: { dark: fg, light: bg } }) : '';
  return `<!doctype html><meta charset="utf-8"><style>
html,body{height:100%;margin:0}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4vh;background:${bg};color:${fg};font-family:system-ui,sans-serif}
svg{height:68vh;width:68vh;max-width:90vw}p{margin:0;font-size:6vh;font-weight:600;text-align:center}
</style>${svg}<p>${esc(cfg.caption)}</p>`;
}
