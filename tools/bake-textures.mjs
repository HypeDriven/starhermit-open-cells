// Bakes the browser build's procedural canvas textures (src/render.js before
// the engine port: cardTexture and surfaceTexture) into assets/textures/ by
// running that canvas code unchanged in Chrome (~/games/tools/gpu-chrome.mjs).
// Per-pixel noise and canvas text paint far too slowly on the engine's canvas
// at start-up, so the engine client loads these images instead
// (native/render.ts):
//   faces-<theme>[-<palette>]-plain.webp     the 52 faces at 128 × 184 (Surface detail Plain: Low)
//   faces-<theme>[-<palette>]-detailed.webp  the 52 faces at 256 × 368 with the linen weave and gilt rule
//                                (Detailed: Balanced and up; Ultra's 3× faces use these too)
//   wood-<px>.png, slate-<px>.png, felt-<px>.png   grey surface textures per texture budget
//     (wood 256 / 512 / 1024, slate and felt half of that)
// (the colour-vision palettes deuteranopia / tritanopia recolour the suits, as html[data-palette] did)
// Atlases: 13 columns (ranks A…K) × 4 rows (suits ♠ ♥ ♦ ♣, card id = suit × 13 + rank − 1).
// Run once; commit the images.   node tools/bake-textures.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Content = require('../src/content.js');
function findPlaywright() {
  const roots = [root, resolve(root, '..'), ...readdirSync(resolve(root, '..')).map((d) => resolve(root, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

// The old src/render.js painters, verbatim but returning canvases.
const painters = String.raw`
var RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
var SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
function cardCanvas(cardId, theme, hi, scale) {
  var k = hi ? (scale || 2) : 1;
  var W = 128, H = 184;
  var cv = document.createElement('canvas');
  cv.width = W * k; cv.height = H * k;
  var g = cv.getContext('2d');
  g.scale(k, k);
  var suit = Math.floor(cardId / 13), rank = (cardId % 13) + 1;
  var red = suit === 1 || suit === 2;
  var ink = red ? theme.suitRed : theme.suitBlack;
  g.fillStyle = theme.cardFace;
  g.fillRect(0, 0, W, H);
  var s = (cardId + 1) * 2654435761 >>> 0;
  for (var i = 0; i < 60; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    g.fillStyle = 'rgba(0,0,0,0.018)';
    g.fillRect(s % W, (s >>> 8) % H, 3, 3);
  }
  if (hi) {
    g.lineWidth = 0.5;
    g.strokeStyle = 'rgba(90,70,40,0.045)';
    for (var y = 0.5; y < H; y += 1.5) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.strokeStyle = 'rgba(90,70,40,0.035)';
    for (var x = 0.5; x < W; x += 1.5) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    var edge = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.62);
    edge.addColorStop(0, 'rgba(255,250,235,0)');
    edge.addColorStop(1, 'rgba(120,95,50,0.07)');
    g.fillStyle = edge; g.fillRect(0, 0, W, H);
    g.strokeStyle = theme.deskTrim; g.globalAlpha = 0.55; g.lineWidth = 0.8;
    g.strokeRect(5.5, 42.5, W - 11, H - 85);
    g.globalAlpha = 1;
  }
  g.fillStyle = ink;
  g.font = 'bold 36px Georgia, serif';
  g.textAlign = 'left'; g.textBaseline = 'top';
  var label = RANK_LABELS[rank - 1];
  var sym = SUIT_SYMBOLS[suit];
  g.fillText(label, 8, 4);
  g.font = '30px Georgia, serif';
  g.fillText(sym, label.length > 1 ? 52 : 36, 6);
  g.save();
  g.translate(W, H); g.rotate(Math.PI);
  g.font = 'bold 36px Georgia, serif';
  g.fillText(label, 8, 4);
  g.font = '30px Georgia, serif';
  g.fillText(sym, label.length > 1 ? 52 : 36, 6);
  g.restore();
  g.textAlign = 'center';
  g.font = '54px Georgia, serif';
  g.textBaseline = 'middle';
  g.fillText(sym, W / 2, H / 2 - 6);
  if (rank >= 11) {
    g.strokeStyle = ink; g.lineWidth = 2;
    g.strokeRect(W / 2 - 24, H / 2 + 18, 48, 10);
  } else if (rank === 1) {
    g.beginPath(); g.arc(W / 2, H / 2 + 26, 8, 0, Math.PI * 2); g.strokeStyle = ink; g.lineWidth = 2; g.stroke();
  }
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
  g.strokeRect(1, 1, W - 2, H - 2);
  return cv;
}
function surfaceCanvas(kind, size) {
  var cv = document.createElement('canvas');
  cv.width = cv.height = size;
  var g = cv.getContext('2d');
  var img = g.createImageData(size, size);
  var d = img.data;
  var seed = kind === 'slate' ? 7 : kind === 'felt' ? 13 : 29;
  function hash(x, y) {
    var h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise(x, y, period) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    function c(a, b) { return hash(((a % period) + period) % period, ((b % period) + period) % period); }
    return (c(xi, yi) * (1 - u) + c(xi + 1, yi) * u) * (1 - v) + (c(xi, yi + 1) * (1 - u) + c(xi + 1, yi + 1) * u) * v;
  }
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      var v;
      if (kind === 'slate') {
        var n = vnoise(x / 64, y / 64, size / 64) * 0.5 + vnoise(x / 16, y / 16, size / 16) * 0.3 + vnoise(x / 4, y / 4, size / 4) * 0.2;
        v = 0.86 + n * 0.14 + (hash(x, y) - 0.5) * 0.02;
      } else if (kind === 'felt') {
        var f = vnoise(x / 2, y / 2, size / 2) * 0.7 + hash(x, y) * 0.3;
        v = 0.9 + f * 0.08 + (vnoise(x / 32, y / 32, size / 32) - 0.5) * 0.05;
      } else {
        var grain = vnoise(x / 180, y / 5, Math.max(1, size / 180)) * 6 + vnoise(x / 40, y / 40, size / 40) * 1.5;
        var ring = 0.5 + 0.5 * Math.sin(grain * Math.PI * 2);
        v = 0.7 + ring * 0.22 + (hash(x, y) - 0.5) * 0.04;
      }
      var b = Math.max(0, Math.min(255, Math.round(v * 255)));
      var o = (y * size + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = b; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}
function atlas(theme, hi) {
  var w = hi ? 256 : 128, h = hi ? 368 : 184;
  var cv = document.createElement('canvas');
  cv.width = 13 * w; cv.height = 4 * h;
  var g = cv.getContext('2d');
  for (var id = 0; id < 52; id++) g.drawImage(cardCanvas(id, theme, hi, 2), (id % 13) * w, Math.floor(id / 13) * h);
  return cv;
}
`;

// Suit colour palettes (the old html[data-palette] card colours), over every theme.
const PALETTES = { deuteranopia: { suitRed: '#b0660a', suitBlack: '#2050a0' }, tritanopia: { suitRed: '#c03040', suitBlack: '#2060b0' } };
const jobs = [];
for (const t of Content.THEMES) {
  for (const [pal, over] of [['', {}], ...Object.entries(PALETTES).map(([k, v]) => ['-' + k, v])]) {
    const th = JSON.stringify(Object.assign({}, t, over));
    jobs.push([`faces-${t.id}${pal}-plain.webp`, `atlas(${th}, false)`]);
    jobs.push([`faces-${t.id}${pal}-detailed.webp`, `atlas(${th}, true)`]);
  }
}
for (const tb of [256, 512, 1024]) {
  jobs.push([`wood-${tb}.png`, `surfaceCanvas('wood', ${tb})`]);
  jobs.push([`slate-${tb / 2}.png`, `surfaceCanvas('slate', ${tb / 2})`]);
  jobs.push([`felt-${tb / 2}.png`, `surfaceCanvas('felt', ${tb / 2})`]);
}

const out = join(root, 'assets', 'textures');
mkdirSync(out, { recursive: true });
const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, close } = await launchChrome(chromium);
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: painters });
for (const [file, expr] of jobs) {
  const url = await page.evaluate(async ([e, webp]) => {
    const cv = await (0, eval)(e);
    return webp ? cv.toDataURL('image/webp', 0.92) : cv.toDataURL('image/png');
  }, [expr, file.endsWith('.webp')]);
  writeFileSync(join(out, file), Buffer.from(url.split(',')[1], 'base64'));
  console.log(file);
}
await close();
