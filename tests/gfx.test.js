'use strict';
/* Open Cells — graphics quality model tests. Run: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gfx.js');

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(G.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(G.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(G.detectPreset('Apple M2'), 'high');
  assert.equal(G.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(G.detectPreset('Mali-G78'), 'balanced');
  assert.equal(G.detectPreset(''), 'balanced');
  // Touch devices cap Auto at Balanced.
  assert.equal(G.detectPreset('Apple M2', true), 'balanced');
  assert.equal(G.detectPreset('SwiftShader', true), 'low');
});

test('resolve: auto uses the detected preset', () => {
  const r = G.resolve({}, 'low');
  assert.equal(r.preset, 'low');
  assert.equal(r.auto, true);
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, false, 'Low renders directly, no composer');
  assert.equal(r.adaptive, true);
  assert.equal(r.showFps, false);
  assert.equal(G.resolve({ preset: 'auto' }, 'nonsense').preset, 'balanced');
});

test('resolve: explicit preset and per-category overrides', () => {
  const r = G.resolve({ preset: 'high', bloom: 'off', shadows: 'high', particles: 'bogus' }, 'low');
  assert.equal(r.preset, 'high');
  assert.equal(r.auto, false);
  assert.equal(r.bloom, 'off');
  assert.equal(r.shadows, 'high');
  assert.equal(r.particles, G.presetTier('high', 'particles'), 'invalid tier falls back to preset');
  assert.equal(r.reflections, 'on');
  assert.equal(r.post, true);
  // MSAA alone still needs the composer (the canvas has no native AA).
  assert.equal(G.resolve({ preset: 'low', antialias: 'msaa' }, 'low').post, true);
});

test('resolve: render scale is clamped to 50–200% and multiplies the preset scale', () => {
  assert.equal(G.resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(G.resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(G.resolve({ preset: 'high', render_scale: 0.8 }).scale, 0.8);
  assert.equal(G.resolve({ preset: 'ultra', render_scale: 2 }).scale, 2.5);
  assert.equal(G.resolve({ preset: 'high' }).renderScale, 1);
});

test('choosing a preset clears overrides but keeps scale / adaptive / fps', () => {
  const next = G.choosePreset({ preset: 'high', bloom: 'off', grade: 'off', render_scale: 1.5, adaptive: false, show_fps: true }, 'ultra');
  assert.deepEqual(next, { preset: 'ultra', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.equal(G.resolve(next).bloom, G.presetTier('ultra', 'bloom'));
  assert.equal(G.choosePreset({}, 'weird').preset, 'auto');
});

test('legacy quality tier migrates to a preset', () => {
  assert.equal(G.fromLegacy('medium').preset, 'balanced');
  assert.equal(G.fromLegacy('high').preset, 'high');
  assert.equal(G.fromLegacy('auto').preset, 'auto');
});

test('describe summarises cost; strings exist for every locale', () => {
  const d = G.describe(G.resolve({ preset: 'high' }), [1920, 1080]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1920×1080 px/);
  assert.match(G.describe(G.resolve({ preset: 'low' })), /no shadows · no anti-aliasing/);
  const en = G.strings('en-US');
  const keys = ['quality', 'auto', 'renderScale', 'fromPreset', 'adaptive', 'showFps', 'postFailed']
    .concat(Object.keys(G.CATEGORIES).map((c) => 'cat_' + c));
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(G.LOCALES.includes(loc), loc);
    const t = G.strings(loc);
    for (const k of keys) assert.notEqual(t(k), k, `${loc} missing ${k}`);
  }
  assert.equal(G.strings('de-DE')('cat_shadows'), 'Schatten');
  assert.equal(G.strings('en-GB')('cat_grade'), 'Colour grade');
  assert.equal(G.strings('es-MX')('quality'), 'Calidad');
  assert.equal(G.pickLocale('fr-CA'), 'fr-CA');
  assert.equal(en('auto', 'Low'), 'Auto (detected: Low)');
});
