const safeColor = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => `&#${m.charCodeAt(0)};`);
const cache = new Map();
const TTL = 5 * 60e3;

export function parseTitles(xml) {
  const items = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  return items.map((block) => {
    const raw = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] || '';
    return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").trim();
  }).filter(Boolean);
}

async function titles(url, safeFetch) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.titles;
  try {
    const list = parseTitles(await safeFetch(url));
    cache.set(url, { at: Date.now(), titles: list });
    return list;
  } catch (e) {
    if (hit) return hit.titles; // stale headlines beat an empty screen
    throw e;
  }
}

export async function render(_type, cfg, { safeFetch }) {
  const bg = safeColor(cfg.bg, '#111111');
  const fg = safeColor(cfg.color, '#ffffff');
  let list = [];
  let error = '';
  try { list = (await titles(String(cfg.url), safeFetch)).slice(0, Number(cfg.limit) || 10); }
  catch (e) { error = e.message; }
  const css = `html,body{height:100%;margin:0;overflow:hidden}body{background:${bg};color:${fg};font-family:system-ui,sans-serif}`;
  if (error || !list.length) {
    return `<!doctype html><meta charset="utf-8"><style>${css}body{display:flex;align-items:center;justify-content:center;font-size:3vw;opacity:.7}</style>${esc(error ? `Feed unavailable: ${error}` : 'No headlines')}`;
  }
  if (cfg.layout === 'list') {
    return `<!doctype html><meta charset="utf-8"><style>${css}ul{list-style:none;margin:0;padding:4vh 5vw;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-around}
li{font-size:clamp(14px,3.2vw,9vh);line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style><ul>${list.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
  }
  const seconds = Math.max(20, list.join('').length / 8);
  return `<!doctype html><meta charset="utf-8"><style>${css}body{display:flex;align-items:center}
.t{display:inline-block;white-space:nowrap;font-size:70vh;line-height:1;padding-left:100%;animation:s ${seconds}s linear infinite}
@media (min-aspect-ratio:1/1) and (min-height:30vw){.t{font-size:6vw}}span{margin-right:6vw}@keyframes s{to{transform:translateX(-100%)}}</style><div class="t">${list.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`;
}
