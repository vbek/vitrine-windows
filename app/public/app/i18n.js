// English strings are the keys; a missing translation falls back to English.
// `npm run i18n:check` lists any string in the app missing from these dictionaries.
import { fr } from './lang/fr.js';
import { es } from './lang/es.js';

export const LANGS = [['en', 'English'], ['fr', 'Français'], ['es', 'Español']];
const dicts = { fr, es };
let dict = null;
// Singular forms for count strings. Language files add the same thing as '<key>|one'.
const ONE = {
  '{n} slides': '{n} slide', 'On {n} screens': 'On {n} screen', 'In {n} playlists': 'In {n} playlist', '{n} plays': '{n} play',
  '{n} people': '{n} person', '{n} targets': '{n} target', 'Delete {n} items?': 'Delete {n} item?',
  'It will also be removed from {n} playlists.': 'It will also be removed from {n} playlist.',
  '{n} added to the library': '{n} added to the library', 'All {n} screens are on air.': 'Your screen is on air.',
};

export function setLang(code) {
  dict = dicts[code] || null;
  document.documentElement.lang = dicts[code] ? code : 'en';
}

export function t(key, vars) {
  const one = vars?.n === 1 ? (dict ? dict[`${key}|one`] : ONE[key]) : null;
  let s = one ?? dict?.[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
