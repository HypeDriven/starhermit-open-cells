'use strict';
/* Key extraction for the i18n coverage test (run directly to list the keys).
 * Keys are the US-English source strings: literal T('…') / N('…') calls in
 * native/*.ts, the rules and session refusal sentences, and the content
 * tables' display fields. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');

function sourceKeys() {
  const keys = new Set();
  const call = /(?<![\w$.])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  for (const f of fs.readdirSync(path.join(ROOT, 'native'))) {
    if (!f.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(ROOT, 'native', f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
  }
  for (const f of ['rules.js', 'session.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    for (const m of src.matchAll(/fail\('[^']+', '((?:[^'\\]|\\.)*)'\)/g)) keys.add(unescape(m[1]));
    for (const m of src.matchAll(/message: '((?:[^'\\]|\\.)*)'/g)) keys.add(unescape(m[1]));
  }
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
if (require.main === module) for (const k of [...ALL].sort()) console.log(k);
