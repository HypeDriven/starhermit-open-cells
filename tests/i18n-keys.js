'use strict';
/* Key extraction for the i18n coverage test (run directly to list the keys).
 * Keys are the US-English source strings: literal T('…') / L('…') / N('…')
 * calls in src/, data-i18n / data-i18n-aria markup in index.html, rules and
 * session refusal sentences, and the content tables' display fields. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['i18n.js', 'gfx.js', 'sh-language.js', 'starhermit-sdk.js']);
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');

function sourceKeys() {
  const keys = new Set();
  const call = /(?<![\w$])(?:T|L|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (!f.endsWith('.js') || SKIP.has(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    // Refusal sentences (rules.js fail(reason, message), session.js message: '…').
    for (const m of src.matchAll(/fail\('[^']+', '((?:[^'\\]|\\.)*)'\)/g)) keys.add(unescape(m[1]));
    for (const m of src.matchAll(/message: '((?:[^'\\]|\\.)*)'/g)) keys.add(unescape(m[1]));
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) keys.add(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  return keys;
}

function contentKeys() {
  const C = require('../src/content.js');
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  for (const l of C.LESSONS) { add(l.title, l.intro); l.steps.forEach((s) => add(s.text)); }
  for (const s of C.JOURNEY) add(s.title);
  for (const c of C.CHALLENGES) add(c.title, c.description);
  for (const p of C.PRACTICE_DIFFICULTIES) add(p.title, p.description);
  for (const t of C.THEMES) add(t.name);
  for (const a of C.ACHIEVEMENTS) add(a.title, a.description);
  return keys;
}

const ALL = new Set([...sourceKeys(), ...contentKeys()]);
module.exports = { ALL, sourceKeys, contentKeys };

if (require.main === module) console.log(JSON.stringify([...ALL], null, 1));
