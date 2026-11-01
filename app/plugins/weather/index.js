const safeColor = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => `&#${m.charCodeAt(0)};`);
const cache = new Map();
const TTL = 15 * 60e3;

const CODES = [[0, 'Clear'], [3, 'Partly cloudy'], [48, 'Fog'], [57, 'Drizzle'], [67, 'Rain'], [77, 'Snow'], [82, 'Showers'], [86, 'Snow showers'], [99, 'Thunderstorm']];
const describe = (code) => CODES.find(([max]) => code <= max)?.[1] ?? '';

async function load(city, units, safeFetch) {
  const key = `${city}|${units}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  try {
    const geo = JSON.parse(await safeFetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`));
    const place = geo.results?.[0];
    if (!place) throw new Error(`Could not find "${city}"`);
    const data = JSON.parse(await safeFetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto&temperature_unit=${units === 'fahrenheit' ? 'fahrenheit' : 'celsius'}`));
    const out = { place: place.name, data };
    cache.set(key, { at: Date.now(), data: out });
    return out;
  } catch (e) {
    if (hit) return hit.data;
    throw e;
  }
}

export async function render(_type, cfg, { safeFetch }) {
  const bg = safeColor(cfg.bg, '#17324d');
  const fg = safeColor(cfg.color, '#ffffff');
  const css = `html,body{height:100%;margin:0}body{background:${bg};color:${fg};font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}`;
  try {
    const { place, data: d } = await load(String(cfg.city), cfg.units, safeFetch);
    const days = d.daily.time.slice(1).map((t, i) => `<div><b>${new Date(`${t}T12:00`).toLocaleDateString([], { weekday: 'short' })}</b><br>${Math.round(d.daily.temperature_2m_max[i + 1])}° / ${Math.round(d.daily.temperature_2m_min[i + 1])}°<br><small>${describe(d.daily.weather_code[i + 1])}</small></div>`).join('');
    return `<!doctype html><meta charset="utf-8"><style>${css}h1{font-size:4vw;margin:0;font-weight:500}.t{font-size:15vw;font-weight:700;line-height:1.05}.c{font-size:3.4vw;opacity:.85}.f{display:flex;gap:6vw;margin-top:4vh;font-size:2.4vw;line-height:1.4}small{opacity:.75}</style>
<h1>${esc(place)}</h1><div class="t">${Math.round(d.current.temperature_2m)}°</div><div class="c">${describe(d.current.weather_code)}</div><div class="f">${days}</div>`;
  } catch (e) {
    return `<!doctype html><meta charset="utf-8"><style>${css}body{font-size:3vw;opacity:.7}</style>Weather unavailable: ${esc(e.message)}`;
  }
}
