// Lists t('...') strings missing from a language file. --dump prints them all as JSON keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app');

const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory() && e.name !== 'lang') walk(p);
  else if (e.name.endsWith('.js') && e.name !== 'i18n.js') files.push(p);
});
walk(appDir);

const keys = new Set();
const re = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;
for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) keys.add(m[1].replace(/\\'/g, "'"));

if (process.argv.includes('--dump')) { console.log([...keys].sort().join('\n')); process.exit(0); }

let bad = 0;
for (const lang of ['fr', 'es']) {
  const { [lang]: dict } = await import(new URL(`../public/app/lang/${lang}.js`, import.meta.url));
  const missing = [...keys].filter((k) => !(k in dict));
  const extra = Object.keys(dict).filter((k) => !keys.has(k.replace(/\|one$/, '')));
  console.log(`${lang}: ${keys.size - missing.length}/${keys.size} translated, ${extra.length} unused`);
  missing.forEach((k) => console.log(`  missing: ${k}`));
  extra.forEach((k) => console.log(`  unused: ${k}`));
  bad += missing.length;
}
process.exit(bad ? 1 : 0);
