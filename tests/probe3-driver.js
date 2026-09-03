'use strict';
/* Probe 3: win path — terminal detection, results with stars, achievements, board entry. */
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
    var R = window.OCRules, C = window.OCContent;

    // Start journey stage 1, then swap in a near-win state (four kings out).
    app.ui.closeAll();
    var st1 = C.JOURNEY[0];
    app.ui.closeAll();
    // Drive through the real journey setup path.
    app.ui.showJourney({ journey: {} });
    await waitFor(function () { return document.querySelector('.journey-cell'); }, 'grid');
    clickEl(document.querySelector('.journey-cell'));
    await waitFor(function () { return $('.screen-overlay[data-screen="stage-setup"]'); }, 'setup');
    clickEl(Array.from(document.querySelectorAll('.screen-overlay[data-screen="stage-setup"] button')).find(function (b) { return /begin/i.test(b.textContent); }));
    await waitFor(function () { return app.session && app.config.mode === 'journey'; }, 'journey session');

    // Craft: foundations hold A..Q of every suit; kings on column tops.
    var s = app.session.state;
    var tableau = Array.from({ length: 8 }, function () { return []; });
    tableau[0] = [12]; tableau[1] = [25]; tableau[2] = [38]; tableau[3] = [51];
    s.tableau = tableau;
    s.foundations = [[], [], [], []];
    for (var suit = 0; suit < 4; suit++) for (var r = 1; r <= 12; r++) s.foundations[suit].push(suit * 13 + r - 1);
    R.validateStateShape(s);
    app.session.state = s;
    // Re-render via a no-op: select and deselect through the DOM board render.
    app.ui.announce('probe');

    // Win via the Collect auto action (all kings are safe: all lower cards home).
    var kingsSafe = R.findSafeAutoMoves(s).length;
    log(kingsSafe === 4, 'four kings are safe to collect', 'safe=' + kingsSafe);
    clickEl($('#btn-auto'));
    await waitFor(function () { return app.session.state.status === 'won'; }, 'won');
    log(app.session.state.terminalReason === 'all-foundations-complete', 'terminal reason recorded');
    await waitFor(function () { return $('.screen-overlay[data-screen="results"]'); }, 'results');
    log(!!$('.score-table'), 'score breakdown shown');
    var headline = $('.results-headline');
    log(headline && /cleared/i.test(headline.textContent), 'win headline');
    log(!!$('.results-stars'), 'stars shown for journey win');
    log(!!$('.results-ach'), 'achievement unlocked section shown');
    var save = window.OCPlatform.loadSave().doc;
    log(!!save.achievements['first-completion'], 'first-completion persisted');
    log(!!save.journey['journey-01'], 'journey stage 1 marked complete');
    log(window.OCPlatform.getBoard('journey').length >= 1, 'journey board has the entry');

    // Next-stage button goes to stage 2.
    var nextBtn = Array.from(document.querySelectorAll('.screen-overlay[data-screen="results"] button')).find(function (b) { return /next/i.test(b.textContent); });
    clickEl(nextBtn);
    await waitFor(function () { return app.session && app.config.journeyStage && app.config.journeyStage.n === 2; }, 'next stage');
    log(true, 'results Next starts stage 2');

    console.log('PROBE3 DONE');
  }).catch(function (e) {
    console.log('FAIL probe3 crashed — ' + String(e && e.stack || e));
    console.log('PROBE3 DONE');
  });
})();
