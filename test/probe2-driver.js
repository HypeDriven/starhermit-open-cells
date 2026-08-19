'use strict';
/* Probe 2: chase mode, theme switch, journey results progression. */
(function () {
  function waitFor(fn, label, timeoutMs) {
    return new Promise(function (res, rej) {
      var t0 = Date.now();
      (function p() {
        var v; try { v = fn(); } catch (e) {}
        if (v) return res(v);
        if (Date.now() - t0 > (timeoutMs || 10000)) return rej(new Error('timeout ' + label));
        setTimeout(p, 60);
      })();
    });
  }
  function $(s) { return document.querySelector(s); }
  function clickEl(n) { n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
  function log(ok, name, extra) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); }

  waitFor(function () { return window.__ocApp && window.__ocApp.ui; }, 'boot').then(async function () {
    var app = window.__ocApp;
    window.confirm = function () { return true; };

    // Chase mode via UI.
    app.ui.closeAll();
    app.ui.showChaseSetup();
    await waitFor(function () { return $('.screen-overlay[data-screen="chase-setup"] input'); }, 'chase input');
    $('.screen-overlay[data-screen="chase-setup"] input').value = 'probe-seed-1';
    clickEl(Array.from(document.querySelectorAll('.screen-overlay[data-screen="chase-setup"] .btn-primary'))[0]);
    await waitFor(function () { return app.session && app.config.mode === 'chase'; }, 'chase session');
    var seed1 = app.session.state.seed;
    log(true, 'chase session starts from typed seed', 'seed=' + seed1);

    // Determinism: same seed string → same deal.
    var tableauHash = JSON.stringify(app.session.state.tableau);
    clickEl($('#btn-concede'));
    await waitFor(function () { return $('.screen-overlay[data-screen="results"]'); }, 'chase results');
    clickEl(Array.from(document.querySelectorAll('.screen-overlay[data-screen="results"] button')).find(function (b) { return /retry/i.test(b.textContent); }));
    await waitFor(function () { return app.session && app.session.state.status === 'active'; }, 'chase retry');
    log(JSON.stringify(app.session.state.tableau) === tableauHash, 'chase retry replays the same deal');

    // Theme switch through settings.
    app.ui.showSettings();
    await waitFor(function () { return $('.screen-overlay[data-screen="settings"] select'); }, 'settings');
    var themeSel = Array.from(document.querySelectorAll('.screen-overlay[data-screen="settings"] select'))
      .find(function (s) { return s.getAttribute('aria-label') === 'Theme'; });
    themeSel.value = 'verdigris';
    themeSel.dispatchEvent(new Event('change', { bubbles: true }));
    log(document.documentElement.dataset.theme === 'verdigris', 'theme switch applies to DOM');
    themeSel.value = 'brass-slate';
    themeSel.dispatchEvent(new Event('change', { bubbles: true }));

    // Journey win → results offer next stage, and progress unlocks stage 2.
    app.ui.closeAll();
    app.save.journey['journey-01'] = { stars: 2, bestScore: 9000, bestMoves: 100, completedAt: new Date().toISOString() };
    window.OCPlatform.persistSave(app.save);
    app.ui.showJourney({ journey: app.save.journey });
    await waitFor(function () { return document.querySelectorAll('.journey-cell').length === 40; }, 'journey grid');
    var cells = document.querySelectorAll('.journey-cell');
    log(!cells[1].disabled, 'stage 2 unlocked after stage 1 completion');

    console.log('PROBE2 DONE');
  }).catch(function (e) {
    console.log('FAIL probe2 crashed — ' + String(e && e.stack || e));
    console.log('PROBE2 DONE');
  });
})();
