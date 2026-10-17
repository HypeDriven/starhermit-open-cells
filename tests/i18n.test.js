'use strict';
/* Every player-facing string exists in all nine locales (node --test).
 * Keys are the US-English source strings (see tests/i18n-keys.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../src/i18n.js');
const G = require('../src/gfx.js');
const { ALL } = require('./i18n-keys.js');

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 300, `only ${ALL.size} keys found`);
});

for (const locale of I.LOCALES.filter((l) => l !== 'en-US' && l !== 'en-GB')) {
  test(`${locale}: every key used in markup and code is translated with the same placeholders`, () => {
    const dict = I.DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of I.LOCALES) {
    const stray = Object.keys(I.DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('Graphics and StarHermit strings exist in all nine locales', () => {
  for (const locale of I.LOCALES) {
    const t = G.strings(locale);
    assert.ok(t('quality') && t('quality') !== 'quality', locale);
    assert.ok(t('sh_signIn') && t('sh_signIn') !== 'sh_signIn', locale);
  }
  assert.notEqual(G.strings('de-DE')('sh_signIn'), G.strings('en-US')('sh_signIn'));
});

test('T falls back to the key and fills placeholders; regional variants inherit', () => {
  I.setLocale('de-DE');
  assert.equal(I.T('Not a real key {x}', { x: 1 }), 'Not a real key 1');
  assert.equal(I.T('{n} moves', { n: 3 }), '3 Züge');
  assert.equal(I.T('Settings'), 'Einstellungen');
  I.setLocale('fr-CA');
  assert.equal(I.T('Score'), 'Pointage');
  assert.equal(I.T('Hint'), 'Indice');
  I.setLocale('es-ES');
  assert.equal(I.T('Settings'), 'Ajustes');
  assert.equal(I.T('Hint'), 'Pista');
  I.setLocale('en-GB');
  assert.equal(I.T('Suit color palette'), 'Suit colour palette');
  assert.equal(I.T('Hint'), 'Hint');
  I.setLocale('xx-YY');
  assert.equal(I.lang(), 'en-US');
});

test('onChange listeners fire only when the locale changes', () => {
  I.setLocale('en-US');
  const seen = [];
  const off = I.onChange((l) => seen.push(l));
  I.setLocale('it-IT');
  I.setLocale('it-IT');
  I.setLocale('pt-BR');
  off();
  I.setLocale('en-US');
  assert.deepEqual(seen, ['it-IT', 'pt-BR']);
});
