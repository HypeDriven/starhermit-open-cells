// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a classic deal and keeps playing it by tapping cards on the 3D table (the rules engine's next
// legal move, located through the renderer's own projection, like a player taps them) — cards fly
// between columns, cells and foundations, foundation sparks burst and the dust motes drift. When no move
// is left the deal is undone back a few steps (the on-screen Undo button) so play never stops.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const overlay = (page, name) => page.locator(`.screen-overlay[data-screen="${name}"]`);
const overlayButton = (page, screen, re) => overlay(page, screen).locator('button', { hasText: re }).first().click();

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__ocApp && window.__ocApp.phase === 'title', null, { timeout: 30000 });
  await overlayButton(page, 'title', /^settings$/i);
  await overlay(page, 'settings').waitFor({ state: 'visible' });
  await overlay(page, 'settings').locator('#gfx-preset').selectOption(preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await overlayButton(page, 'settings', /^done$/i);
  await overlay(page, 'settings').waitFor({ state: 'detached' });
}

// The next legal move as two screen points (source card, then destination), or null.
const nextMove = (page) => page.evaluate(() => {
  const app = window.__ocApp, st = app.session && app.session.state;
  if (!st || st.status !== 'active' || app.phase !== 'active') return { idle: true };
  const acts = window.OCRules.enumerateActions(st).filter((a) => a.kind === 'move');
  // Prefer foundation moves (sparks), then moves into the tableau, then into cells; never ping-pong
  // the last move straight back.
  const last = window.__benchLast || '';
  const rank = (a) => (a.to.zone === 'foundation' ? 0 : a.to.zone === 'tableau' ? 1 : 2);
  acts.sort((a, b) => rank(a) - rank(b));
  const key = (a) => `${a.from.zone}${a.from.index}>${a.to.zone}${a.to.index}`;
  const back = (a) => `${a.to.zone}${a.to.index}>${a.from.zone}${a.from.index}`;
  const a = acts.find((x) => key(x) !== last && back(x) !== last && x.to.zone !== 'cell') || acts.find((x) => back(x) !== last);
  if (!a) return { stuck: true };
  window.__benchLast = key(a);
  const R = app.renderer;
  const depthOf = (loc, top) => loc.zone === 'tableau' ? Math.max(0, st.tableau[loc.index].length - top) : 0;
  return { from: R.screenPos(a.from, depthOf(a.from, a.count)), to: R.screenPos(a.to, depthOf(a.to, 1)) };
});

async function step(page) {
  const m = await nextMove(page);
  if (m.idle) {
    if (await overlay(page, 'results').count()) await overlayButton(page, 'results', /new deal|play again|next/i).catch(() => {});
    return;
  }
  if (m.stuck) {
    // Rail buttons hide on phones; the thumb tray mirrors them.
    const rail = page.locator('#btn-undo');
    const undo = (await rail.isVisible()) ? rail : page.locator('#tray [data-mirror="btn-undo"]');
    for (let i = 0; i < 6; i++) await undo.click({ timeout: 2000 }).catch(() => {});
    return;
  }
  await page.mouse.click(m.from.x, m.from.y);
  await page.waitForTimeout(150);
  await page.mouse.click(m.to.x, m.to.y);
}

export async function start(page) {
  await overlayButton(page, 'title', /^(play|continue)$/i);
  await page.waitForFunction(() => window.__ocApp.phase === 'active' && window.__ocApp.session, null, { timeout: 15000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(700).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
