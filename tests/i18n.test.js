'use strict';
/* Every player-facing string exists in all nine locales (node --test).
 * Keys are the US-English source strings (see tests/i18n-keys.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DICTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'strings.json'), 'utf8'));
const LOCALES = Object.keys(DICTS);
const PARENT = { 'en-GB': 'en-US' };
const { ALL } = require('./i18n-keys.js');

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 300, `only ${ALL.size} keys found`);
});

for (const locale of LOCALES.filter((l) => l !== 'en-US' && l !== 'en-GB')) {
  test(`${locale}: every key used in the native client is translated with the same placeholders`, () => {
    const dict = DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of LOCALES) {
    const stray = Object.keys(DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('regional variants read their own or the shared text', () => {
  const T = (l, k) => { for (let c = l; c; c = PARENT[c]) if (Object.hasOwn(DICTS[c], k)) return DICTS[c][k]; return k; };
  assert.equal(T('de-DE', '{n} moves'), '{n} Züge');
  assert.equal(T('de-DE', 'Settings'), 'Einstellungen');
  assert.equal(T('fr-CA', 'Score'), 'Pointage');
  assert.equal(T('fr-CA', 'Hint'), 'Indice');
  assert.equal(T('es-ES', 'Settings'), 'Ajustes');
  assert.equal(T('es-ES', 'Hint'), 'Pista');
  assert.equal(T('en-GB', 'Suit color palette'), 'Suit colour palette');
  assert.equal(T('en-GB', 'Hint'), 'Hint');
});
