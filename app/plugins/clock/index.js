const safeColor = (c, d) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : d);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => `&#${m.charCodeAt(0)};`);
// JSON embedded in a script tag must not be able to close it.
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

const page = (cfg, body, script) => `<!doctype html><meta charset="utf-8"><style>
html,body{height:100%;margin:0}body{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
background:${safeColor(cfg.bg, '#111111')};color:${safeColor(cfg.color, '#ffffff')};font-family:system-ui,sans-serif;font-variant-numeric:tabular-nums}
.big{font-size:17vw;font-weight:700;line-height:1;letter-spacing:-.02em}.small{font-size:4vw;opacity:.75;margin-top:2vw}
</style>${body}<script>${script}</script>`;

export function render(type, cfg) {
  if (type === 'clock') {
    return page(cfg, '<div class="big" id="t"></div><div class="small" id="d"></div>', `
      const c=${js({ h12: cfg.format === '12', s: !!cfg.seconds, date: !!cfg.date })};
      function tick(){const n=new Date();
        t.textContent=n.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:c.s?'2-digit':undefined,hour12:c.h12});
        d.textContent=c.date?n.toLocaleDateString([], {weekday:'long',year:'numeric',month:'long',day:'numeric'}):'';}
      tick();setInterval(tick,1000);`);
  }
  if (type === 'countdown') {
    return page(cfg, `<div class="small" style="margin:0 0 2vw">${esc(cfg.title)}</div><div class="big" id="t" style="font-size:12vw"></div>`, `
      const target=new Date(${js(cfg.target || '')}).getTime(),done=${js(cfg.done || '')};
      const p=(n)=>String(n).padStart(2,'0');
      function tick(){const ms=target-Date.now();
        if(!(ms>0)){t.textContent=done;t.style.fontSize='8vw';return;}
        const s=Math.floor(ms/1000),d=Math.floor(s/86400);
        t.textContent=(d?d+'d ':'')+p(Math.floor(s/3600)%24)+':'+p(Math.floor(s/60)%60)+':'+p(s%60);}
      tick();setInterval(tick,1000);`);
  }
  return null;
}
