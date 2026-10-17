'use strict';
/* Open Cells — graphics quality model tests. Run: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
// src/gpu-level.js is a classic script in the page (window.StarHermitGpu); install it the same way here.
globalThis.StarHermitGpu = require('../src/gpu-level.js');
const G = require('../src/gfx.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(G.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(G.detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(G.detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(G.detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(G.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.equal(G.detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(G.detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(G.LEVELS)) assert.equal(G.presetForLevel(lv), p);
  assert.equal(G.presetForLevel(3), 'low');
  assert.equal(G.presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(G.detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(G.detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(G.detectPreset('Apple M2', PHONE), 'balanced');
  assert.equal(G.detectPreset('Apple M2', true), 'balanced', 'boolean touch flag still caps');
  assert.equal(G.detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'face', 'texture', 'surfBump', 'curve', 'pool', 'sparks', 'motes', 'bloomRes'];
  for (const p of G.PRESETS) for (const k of keys) assert.ok(G.BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < G.PRESETS.length; i++) for (const k of keys) {
    if (typeof G.BUDGETS.low[k] === 'number') assert.ok(G.BUDGETS[G.PRESETS[i]][k] >= G.BUDGETS[G.PRESETS[i - 1]][k], `${G.PRESETS[i]}.${k}`);
  }
  assert.deepEqual(G.PRESETS.map((p) => G.BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(G.PRESETS.map((p) => G.BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(G.resolve({ preset: 'high' }, 'low', 10).budget, G.BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(G.resolve({ preset: 'ultra' }, 'low', 0).budget, G.resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(G.budgetFor('balanced', 9).motes > G.budgetFor('balanced', 4).motes, 'counts scale up within the preset');
  assert.ok(G.budgetFor('ultra', 20).sparks <= G.SPARK_MAX && G.budgetFor('ultra', 20).motes <= G.MOTE_MAX);
  assert.equal(G.sparkCap(G.resolve({ preset: 'high' }, 'low', 10)), G.BUDGETS.high.sparks);
  assert.equal(G.sparkCap(G.resolve({ preset: 'balanced' }, 'low', 4)), G.BUDGETS.balanced.sparks / 2, 'Particles Low: half');
  assert.equal(G.sparkCap(G.resolve({ preset: 'low' }, 'low', 0)), 0, 'Low: particles off');
  assert.equal(G.resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
  assert.equal(G.resolve({}, 'low', 0).level, 0);
});

test('graphics summary level label in every locale', () => {
  for (const loc of G.LOCALES) assert.match(G.strings(loc)('level', 7), /7$/, loc);
  assert.equal(G.strings('de-DE')('level', 3), 'Stufe 3');
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
