const fs = require('node:fs');
const path = require('node:path');

const folder = path.resolve(__dirname, '../nivra-app/src/assets/i18n');
const languages = ['es', 'en', 'zh-Hans', 'hi', 'ar', 'pt', 'ru', 'ja', 'fr', 'de'];
const catalogs = Object.fromEntries(languages.map(language => [
  language,
  JSON.parse(fs.readFileSync(path.join(folder, `${language}.json`), 'utf8')),
]));
const base = catalogs.es;
const keys = Object.keys(base).sort();
const markers = text => [...text.matchAll(/\{\{[^}]+\}\}|\{\d+\}|%[sd]|https?:\/\/\S+/g)]
  .map(match => match[0]).sort().join('|');
let errors = 0;

for (const language of languages) {
  const catalog = catalogs[language];
  const missing = keys.filter(key => !(key in catalog));
  const extra = Object.keys(catalog).filter(key => !(key in base));
  if (missing.length || extra.length) {
    console.error(`${language}: ${missing.length} missing, ${extra.length} unexpected keys`);
    errors += missing.length + extra.length;
  }
  for (const key of keys) {
    const value = catalog[key];
    if (typeof value !== 'string' || !value.trim()) {
      console.error(`${language}: empty ${key}`);
      errors++;
    } else if (markers(value) !== markers(base[key])) {
      console.error(`${language}: changed placeholder in ${key}`);
      errors++;
    }
  }
}

if (errors) process.exitCode = 1;
else console.log(`${languages.length} language catalogs: ${keys.length} keys and dynamic placeholders verified`);
