// Visual check: screenshots of the title and in-game board at a forced
// graphics preset, desktop + mobile. Usage: node tools/shots.mjs <tag> [preset]
// Output goes to test-results/ (gitignored).
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] || 'shot';
const preset = process.argv[3] || 'high';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"entries":[]}'); return; }
  const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  try { const b = await readFile(path.join(ROOT, p)); res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const OUT = path.join(ROOT, 'test-results');
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const logs = [];
for (const [vp, opts] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['mobile', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }]]) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((q) => {
    const s = { quality: q === 'balanced' ? 'medium' : (q === 'ultra' ? 'high' : q), graphics: { preset: q } };
    localStorage.setItem('open-cells/settings/v1', JSON.stringify(s));
  }, preset);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${vp}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[${vp}] pageerror: ${e.stack}`));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ocApp && window.__ocApp.phase === 'title');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, `${tag}-title-${vp}.png`) });
  await page.locator('.screen-overlay[data-screen="title"] button', { hasText: /^(play|continue)$/i }).first().click();
  await page.waitForFunction(() => window.__ocApp.phase === 'active');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, `${tag}-game-${vp}.png`) });
  // Select a card with the keyboard to show the selection/target markers.
  await page.evaluate(() => {
    const app = window.__ocApp, st = app.session.state;
    const col = st.tableau[0];
    app.renderer.setSelection({ zone: 'tableau', index: 0 }, [col[col.length - 1]]);
    app.renderer.setLegalTargets([{ zone: 'cell', index: 0 }, { zone: 'cell', index: 1 }, { zone: 'tableau', index: 3 }]);
    app.renderer.playEvent('foundation', { loc: { zone: 'foundation', index: 1 } });
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${tag}-select-${vp}.png`) });
  await ctx.close();
}
await browser.close();
server.close();
console.log(logs.length ? logs.join('\n') : 'no console errors/warnings');
