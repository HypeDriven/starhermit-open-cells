/**
 * Open Cells — end-to-end playthrough driven through the real on-screen UI.
 *
 * Serves the repo over an ephemeral local HTTP port, launches system Chrome
 * via playwright-core, and plays the game exactly as a user would:
 * title → Play (classic deal) → legal card moves on the HTML board → hint,
 * undo, collect → pause/resume → settings → concede → results screen →
 * Learn → lesson 1 completed → results. Runs twice: desktop 1280x800 and a
 * fresh mobile context 390x844 with touch.
 *
 * Notes:
 *  - The game is fully playable offline; the StarHermit backend (server.js)
 *    is optional and NOT used here — the test embeds its own static server.
 *  - Concede/restart use window.confirm(); the test accepts those dialogs.
 *  - On mobile (<=1023px) the right rail (incl. Concede) is hidden by design
 *    and the bottom tray mirrors Undo/Hint/Collect/Pause, so the mobile pass
 *    uses the tray buttons and reaches a results screen via the lesson flow.
 *  - Game state (window.__ocApp / window.OCRules) is read only to synchronize
 *    and to decide WHICH on-screen element to click; every action goes
 *    through real UI clicks on visible elements.
 *
 * Exits non-zero on any failure or any non-benign console/page error.
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ts': 'text/plain',
};

// Benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Stub the optional StarHermit API (see server.js header for the schema)
    // so the game's defensive offline probing does not log 404 console noise.
    if (url.pathname.startsWith('/api/v1/')) {
      const body = url.pathname === '/api/v1/time' ? { now: Date.now() }
        : url.pathname === '/api/v1/scores' ? { accepted: false, reason: 'e2e-offline-stub' }
        : url.pathname.startsWith('/api/v1/boards') ? { board: null, entries: [] }
        : { ok: true };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

const errors = [];
const SHOT = (stage, vp) => `/tmp/open-cells-e2e-${stage}-${vp}.png`;

function checkErrors(label) {
  const bad = errors.filter((e) => !browserNoise.test(e));
  if (bad.length) throw new Error(`${label}: ${bad.length} page/console error(s):\n${bad.join('\n')}`);
}

async function runPass(browser, vpName, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[${vpName}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${vpName}] console ${m.type()}: ${m.text()}`);
  });
  page.on('dialog', (d) => d.accept()); // concede/restart confirmations
  errors.length = 0;

  const step = async (name, fn) => { await fn(); console.log(`ok - [${vpName}] ${name}`); };
  const app = (fn) => page.evaluate(fn);
  const waitApp = (fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout: timeout ?? 10000 });
  const overlay = (name) => page.locator(`.screen-overlay[data-screen="${name}"]`);
  // Rail buttons hide on mobile; the tray mirrors them. Click whichever shows.
  const clickAction = async (id) => {
    const rail = page.locator(`#${id}`);
    if (await rail.isVisible()) return rail.click();
    return page.locator(`#tray [data-mirror="${id}"]`).click();
  };
  const overlayButton = (screen, re) =>
    overlay(screen).locator('button', { hasText: re }).first().click();

  try {
    await step('load + title screen visible', async () => {
      await page.goto(BASE, { waitUntil: 'load' });
      await waitApp(() => window.__ocApp && window.__ocApp.ui && window.__ocApp.phase === 'title');
      await overlay('title').waitFor({ state: 'visible' });
      await page.screenshot({ path: SHOT('title', vpName) });
    });

    await step('Graphics settings: presets, override, live apply, persists across reload', async () => {
      const gfx = (id) => overlay('settings').locator(`#${id}`);
      const bodyPreset = () => app(() => document.body.dataset.gfxPreset);
      await overlayButton('title', /^settings$/i);
      await overlay('settings').waitFor({ state: 'visible' });
      // Headless runs use a software GPU, so Auto resolves to Low.
      const autoLabel = await gfx('gfx-preset').locator('option[value="auto"]').textContent();
      if (!/low/i.test(autoLabel)) throw new Error(`Auto should detect Low on a software GPU, got "${autoLabel}"`);
      await gfx('gfx-preset').selectOption('low');
      await waitApp(() => document.body.dataset.gfxPreset === 'low');
      if (!/no shadows/.test(await gfx('gfx-summary').textContent())) throw new Error('Low summary should report no shadows');
      await gfx('gfx-preset').selectOption('high');
      await waitApp(() => document.body.dataset.gfxPreset === 'high');
      await waitApp(() => /2048² shadows/.test(document.getElementById('gfx-summary').textContent));
      // Per-category override: bloom off, then the summary drops it.
      await gfx('gfx-bloom').selectOption('off');
      await waitApp(() => !/bloom/.test(document.getElementById('gfx-summary').textContent));
      await gfx('gfx-fps').check();
      await page.locator('#fps-meter').waitFor({ state: 'attached' });
      await gfx('gfx-scale').scrollIntoViewIfNeeded();
      await page.screenshot({ path: SHOT('graphics', vpName) });
      const stored = await app(() => JSON.parse(localStorage.getItem('open-cells/settings/v1')).graphics);
      if (stored.preset !== 'high' || stored.bloom !== 'off' || !stored.show_fps) {
        throw new Error('graphics settings not persisted: ' + JSON.stringify(stored));
      }
      // Choosing a preset clears overrides.
      await gfx('gfx-preset').selectOption('ultra');
      await waitApp(() => document.body.dataset.gfxPreset === 'ultra');
      if ((await gfx('gfx-bloom').inputValue()) !== 'preset') throw new Error('preset change did not clear overrides');
      await gfx('gfx-preset').selectOption('high');
      await gfx('gfx-bloom').selectOption('off');
      await page.waitForTimeout(500);

      await page.reload({ waitUntil: 'load' });
      await waitApp(() => window.__ocApp && window.__ocApp.phase === 'title');
      if ((await bodyPreset()) !== 'high') throw new Error('graphics preset did not survive reload');
      await overlayButton('title', /^settings$/i);
      await overlay('settings').waitFor({ state: 'visible' });
      if ((await gfx('gfx-preset').inputValue()) !== 'high') throw new Error('preset select not restored');
      if ((await gfx('gfx-bloom').inputValue()) !== 'off') throw new Error('override not restored');
      // Back to Auto (Low here) so the playthrough stays cheap.
      await gfx('gfx-fps').uncheck();
      await gfx('gfx-preset').selectOption('auto');
      await waitApp(() => document.body.dataset.gfxPreset === 'low');
      await overlayButton('settings', /^done$/i);
      await overlay('settings').waitFor({ state: 'detached' });
    });

    await step('enable HTML board via settings (semantic board is clickable)', async () => {
      await overlayButton('title', /^settings$/i);
      await overlay('settings').waitFor({ state: 'visible' });
      const htmlToggle = overlay('settings')
        .locator('.setting-toggle', { hasText: 'HTML board' }).locator('input');
      if (!(await htmlToggle.isChecked())) await htmlToggle.click();
      await waitApp(() => document.body.classList.contains('html-mode'));
      await overlayButton('settings', /^done$/i);
      await overlay('settings').waitFor({ state: 'detached' });
    });

    await step('Play starts a classic deal with 52 cards', async () => {
      await overlayButton('title', /^(play|continue)$/i);
      await waitApp(() => window.__ocApp.phase === 'active' && window.__ocApp.session);
      await waitApp(() => document.querySelectorAll('#dom-board .card').length === 52);
      const tableauLen = await app(() =>
        window.__ocApp.session.state.tableau.flat().length);
      if (tableauLen !== 52) throw new Error(`expected 52 cards in tableau, got ${tableauLen}`);
      await page.screenshot({ path: SHOT('deal', vpName) });
    });

    await step('two legal moves made by clicking cards on the board', async () => {
      for (let i = 0; i < 2; i++) {
        // Read the rules engine only to decide WHICH visible cards to click,
        // and prefer a move whose cards are not covered (stacked cards can
        // intercept pointer events).
        const mv = await app(() => {
          const st = window.__ocApp.session.state;
          const acts = window.OCRules.enumerateActions(st).filter((a) => a.kind === 'move');
          acts.sort((a, b) =>
            ((a.to.zone === 'tableau') === (b.to.zone === 'tableau') ? 0
              : a.to.zone === 'tableau' ? -1 : 1));
          const build = (a) => ({
            fromSel: `[data-loc="${a.from.zone}-${a.from.index}"]` +
              (a.from.zone === 'tableau' ? `[data-depth="${st.tableau[a.from.index].length - a.count}"]` : ''),
            toSel: `[data-loc="${a.to.zone}-${a.to.index}"]` +
              (a.to.zone === 'tableau' && st.tableau[a.to.index].length
                ? `[data-depth="${st.tableau[a.to.index].length - 1}"]` : ''),
          });
          const clickable = (sel) => {
            const el = document.querySelector('#dom-board ' + sel);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hit === el || el.contains(hit);
          };
          let fallback = null;
          for (const a of acts) {
            const cand = build(a);
            if (!fallback) fallback = cand;
            if (clickable(cand.fromSel) && clickable(cand.toSel)) {
              return { ...cand, moves: st.moves, pointerOk: true };
            }
          }
          return { ...fallback, moves: st.moves, pointerOk: false };
        });
        if (!mv.fromSel) throw new Error('rules engine offered no legal move at deal start');
        const from = page.locator(`#dom-board ${mv.fromSel}`).first();
        const to = page.locator(`#dom-board ${mv.toSel}`).first();
        if (mv.pointerOk) {
          await from.click();
          await waitApp(() => !!window.__ocApp.selection);
          await to.click();
        } else {
          // Covered card (stacking intercepts pointer events): use the
          // game's documented keyboard controls (Enter selects/places).
          console.log('  note: move target not pointer-clickable; using keyboard controls');
          await from.focus();
          await page.keyboard.press('Enter');
          await waitApp(() => !!window.__ocApp.selection);
          await to.focus();
          await page.keyboard.press('Enter');
        }
        await waitApp((expected) => window.__ocApp.session.state.moves === expected, mv.moves + 1);
        if (i === 0) await page.screenshot({ path: SHOT('move', vpName) });
      }
    });

    await step('hint produces a suggested action', async () => {
      await clickAction('btn-hint');
      await waitApp(() => !!window.__ocApp.hintAction);
      await page.screenshot({ path: SHOT('hint', vpName) });
    });

    await step('collect (auto) button is accepted', async () => {
      await clickAction('btn-auto');
      // Auto-collect is a single atomic command moving 0..n safe cards.
      await page.waitForTimeout(300);
    });

    await step('undo restores prior state', async () => {
      const before = await app(() => {
        const s = window.__ocApp.session.state;
        return { moves: s.moves, undos: s.undos };
      });
      await clickAction('btn-undo');
      await waitApp((b) => {
        const s = window.__ocApp.session.state;
        return s.undos === b.undos + 1 && s.moves < b.moves;
      }, before);
    });

    await step('pause overlay shows and resume returns to play', async () => {
      await clickAction('btn-pause');
      await overlay('pause').waitFor({ state: 'visible' });
      await waitApp(() => window.__ocApp.phase === 'paused');
      await page.screenshot({ path: SHOT('pause', vpName) });
      await overlayButton('pause', /^resume$/i);
      await waitApp(() => window.__ocApp.phase === 'active');
    });

    await step('settings opens, toggle persists, closes', async () => {
      await clickAction('btn-pause');
      await overlay('pause').waitFor({ state: 'visible' });
      await overlayButton('pause', /^settings$/i);
      await overlay('settings').waitFor({ state: 'visible' });
      const before = await app(() => window.OCPlatform.getSettings());
      await overlay('settings')
        .locator('.setting-toggle', { hasText: 'Mute all' }).locator('input').click();
      await page.screenshot({ path: SHOT('settings', vpName) });
      const after = await app(() => window.OCPlatform.getSettings());
      if (after.muted === before.muted) throw new Error('settings toggle did not persist');
      const stored = await app(() =>
        JSON.parse(localStorage.getItem('open-cells/settings/v1') || 'null'));
      if (!stored || stored.muted !== after.muted) {
        throw new Error('settings not written to localStorage');
      }
      await overlayButton('settings', /^done$/i);
      await overlay('settings').waitFor({ state: 'detached' });
      await overlayButton('pause', /^resume$/i);
      await waitApp(() => window.__ocApp.phase === 'active');
    });

    if (vpName === 'desktop') {
      await step('concede reaches results with score breakdown', async () => {
        await page.locator('#btn-concede').click(); // confirm dialog auto-accepted
        await overlay('results').waitFor({ state: 'visible' });
        await waitApp(() => window.__ocApp.session.state.status === 'lost'
          && window.__ocApp.session.state.terminalReason === 'conceded');
        const headline = await overlay('results').locator('.results-headline').textContent();
        console.log('  headline:', headline.trim());
        const rows = await overlay('results').locator('.score-table tr').count();
        if (rows < 6) throw new Error(`expected score breakdown rows, got ${rows}`);
        await page.screenshot({ path: SHOT('results', vpName) });
        await overlayButton('results', /^leave$/i);
        await overlay('title').waitFor({ state: 'visible' });
      });
    } else {
      await step('mobile: leave mid-deal back to title', async () => {
        await clickAction('btn-pause');
        await overlay('pause').waitFor({ state: 'visible' });
        await overlayButton('pause', /^leave deal$/i);
        await overlay('title').waitFor({ state: 'visible' });
        await page.screenshot({ path: SHOT('leave-title', vpName) });
      });
    }

    await step('lesson 1 completes through the board and reaches results', async () => {
      await overlayButton('title', /^learn$/i);
      await overlay('learn').waitFor({ state: 'visible' });
      await overlay('learn').locator('.lesson-row button').first().click();
      await waitApp(() => window.__ocApp.phase === 'active'
        && window.__ocApp.config.mode === 'learn');
      // Lesson 1: move the 6 of spades (column 3) onto the 7 of hearts (column 2).
      const fromCard = page.locator('#dom-board [data-loc="tableau-3"][data-depth="0"]');
      const toCard = page.locator('#dom-board [data-loc="tableau-2"][data-depth="0"]');
      const clickable = async (loc) => loc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === el || el.contains(hit);
      });
      if ((await clickable(fromCard)) && (await clickable(toCard))) {
        await fromCard.click();
        await waitApp(() => !!window.__ocApp.selection);
        await toCard.click();
      } else {
        // Covered by another element: use the game's documented keyboard
        // controls (arrows navigate, Enter selects/places).
        console.log('  note: lesson card not pointer-clickable; using keyboard controls');
        await fromCard.focus();
        await page.keyboard.press('Enter');
        await waitApp(() => !!window.__ocApp.selection);
        await toCard.focus();
        await page.keyboard.press('Enter');
      }
      await overlay('results').last().waitFor({ state: 'visible' });
      // Regression guard: lesson completion must present exactly one Results
      // dialog (session used to emit the final lesson-step event twice).
      const dupResults = await overlay('results').count();
      if (dupResults !== 1) throw new Error(`expected 1 results overlay, got ${dupResults}`);
      const results = overlay('results').last();
      const headline = await results.locator('.results-headline').textContent();
      console.log('  lesson headline:', headline.trim());
      await page.screenshot({ path: SHOT('lesson-results', vpName) });
      const progress = await app(() => {
        const doc = JSON.parse(localStorage.getItem('open-cells/save/v1') || 'null');
        return doc && doc.payload ? JSON.parse(doc.payload).lessons : null;
      });
      if (!progress || !progress['learn-tableau']) throw new Error('lesson progress not saved');
      await results.locator('button', { hasText: /^leave$/i }).first().click();
      await overlay('title').last().waitFor({ state: 'visible' });
    });

    checkErrors(vpName);
    console.log(`ok - [${vpName}] pass complete, no page errors`);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--mute-audio'],
});

let failed = null;
try {
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } });
  await runPass(browser, 'mobile', {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
  });
} catch (e) {
  failed = e;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failed) {
  console.error('\nE2E FAIL:', failed.message);
  process.exit(1);
}
const bad = errors.filter((e) => !browserNoise.test(e));
if (bad.length) {
  console.error('\nE2E FAIL — page/console errors:\n' + bad.join('\n'));
  process.exit(1);
}
console.log('\nE2E PASS — open-cells playable end-to-end on desktop and mobile, no page errors');
