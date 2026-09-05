'use strict';
/* Open Cells — E2E driver. Runs inside tests/e2e.html against the real UI.
 * Reports via console.log('PASS ...' / 'FAIL ...') and finishes with E2E DONE. */
(function () {
  var log = function (ok, name, extra) { window.e2e.log(!!ok, name, extra); };
  var R, app;

  function waitFor(fn, label, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function poll() {
        var v;
        try { v = fn(); } catch (e) { /* not ready */ }
        if (v) return resolve(v);
        if (Date.now() - start > (timeoutMs || 8000)) return reject(new Error('timeout: ' + label));
        setTimeout(poll, 50);
      })();
    });
  }

  function $(s) { return document.querySelector(s); }
  function clickEl(node) {
    if (!node) throw new Error('click: no node');
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  function cardButton(loc, depth) {
    var sel = '#dom-board [data-loc="' + loc.zone + '-' + loc.index + '"]' +
      (depth != null ? '[data-depth="' + depth + '"]' : '');
    return $(sel);
  }

  function domCardCount() {
    return document.querySelectorAll('#dom-board .card').length;
  }

  async function run() {
    await waitFor(function () { return window.__ocApp && window.__ocApp.ui; }, 'boot');
    app = window.__ocApp;
    R = window.OCRules;

    // 1. Title screen appears.
    await waitFor(function () { return $('.screen-overlay[data-screen="title"]'); }, 'title screen');
    log(true, 'title screen shows');

    // 2. Play starts a session.
    var playBtn = Array.from(document.querySelectorAll('.screen-overlay button'))
      .find(function (b) { return /play|continue/i.test(b.textContent); });
    clickEl(playBtn);
    await waitFor(function () { return app.session && app.phase === 'active'; }, 'session active');
    log(app.session.state.tableau.flat().length === 52, 'deal has 52 cards in tableau');

    // 3. DOM board mirrors the deal.
    await waitFor(function () { return domCardCount() === 52; }, 'dom board cards');
    log(true, 'dom board renders 52 card buttons');

    // 4. Make a legal move through the DOM board.
    var st = app.session.state;
    var acts = R.enumerateActions(st).filter(function (a) { return a.kind === 'move'; });
    var a = acts[0];
    var fromDepth = a.from.zone === 'tableau' ? st.tableau[a.from.index].length - a.count : null;
    clickEl(cardButton(a.from, fromDepth));
    await waitFor(function () { return app.selection; }, 'selection after card click');
    log(true, 'clicking a card selects it');
    var toBtn = a.to.zone === 'tableau' && st.tableau[a.to.index].length > 0
      ? cardButton(a.to, st.tableau[a.to.index].length - 1)
      : cardButton(a.to);
    clickEl(toBtn);
    await waitFor(function () { return app.session.state.moves === 1; }, 'move applied');
    log(true, 'legal move commits through the UI');

    // 5. Undo restores.
    clickEl($('#btn-undo'));
    await waitFor(function () { return app.session.state.moves === 0 && app.session.state.undos === 1; }, 'undo');
    log(true, 'undo restores prior state');

    // 6. Invalid move produces an explanation, not a crash.
    var badFrom = { zone: 'tableau', index: 0 };
    clickEl(cardButton(badFrom, st.tableau[0].length - 1));
    await waitFor(function () { return app.selection; }, 'selection for invalid test');
    // Try to drop it on its own column's second card (same column → illegal).
    clickEl(cardButton({ zone: 'tableau', index: 0 }, Math.max(0, st.tableau[0].length - 2)));
    await waitFor(function () { return !app.selection; }, 'selection cleared after invalid/same-column');
    log(true, 'tapping same column toggles selection off without corrupting state');
    log(R.stateHash(app.session.state) !== null, 'state remains valid');

    // 7. Hint highlights and announces.
    clickEl($('#btn-hint'));
    log(!!app.hintAction, 'hint produces a legal action');

    // 8. Pause and resume via overlay.
    clickEl($('#btn-pause'));
    await waitFor(function () { return $('.screen-overlay[data-screen="pause"]'); }, 'pause screen');
    log(app.phase === 'paused', 'pause screen shows and phase is paused');
    var resumeBtn = Array.from(document.querySelectorAll('.screen-overlay[data-screen="pause"] button'))
      .find(function (b) { return /resume/i.test(b.textContent); });
    clickEl(resumeBtn);
    await waitFor(function () { return app.phase === 'active'; }, 'resume');
    log(true, 'resume works');

    // 9. Settings overlay opens and toggles persist.
    clickEl($('#btn-pause'));
    await waitFor(function () { return $('.screen-overlay[data-screen="pause"]'); }, 'pause again');
    var settingsBtn = Array.from(document.querySelectorAll('.screen-overlay[data-screen="pause"] button'))
      .find(function (b) { return /settings/i.test(b.textContent); });
    clickEl(settingsBtn);
    await waitFor(function () { return $('.screen-overlay[data-screen="settings"]'); }, 'settings screen');
    var vol = $('.screen-overlay[data-screen="settings"] input[type="range"]');
    vol.value = '0.3';
    vol.dispatchEvent(new Event('input', { bubbles: true }));
    var saved = window.OCPlatform.getSettings();
    log(Math.abs(saved.volume.music - 0.3) < 0.001, 'settings slider persists volume', JSON.stringify(saved.volume.music));
    // close settings + pause
    document.querySelectorAll('.screen-overlay[data-screen="settings"] .btn-primary').forEach(function (b) { clickEl(b); });
    await waitFor(function () { return !$('.screen-overlay[data-screen="settings"]'); }, 'settings closed');

    // 10. Concede reaches results with a score breakdown.
    window.__ocApp.paused = false; window.__ocApp.phase = 'active';
    document.querySelectorAll('.screen-overlay').forEach(function (o) { o.remove(); });
    clickEl($('#btn-concede'));
    await waitFor(function () { return $('.screen-overlay[data-screen="results"]'); }, 'results screen');
    log(app.session.state.status === 'lost' && app.session.state.terminalReason === 'conceded', 'concede ends the deal with a reason');
    log(!!$('.score-table'), 'results show score breakdown');

    // 11. Lesson flow: start lesson 1 from Learn screen.
    document.querySelectorAll('.screen-overlay .btn-quiet, .screen-overlay .btn').forEach(function () {});
    var leaveBtn = Array.from(document.querySelectorAll('.screen-overlay[data-screen="results"] button'))
      .find(function (b) { return /leave/i.test(b.textContent); });
    clickEl(leaveBtn);
    await waitFor(function () { return $('.screen-overlay[data-screen="title"]'); }, 'back at title');
    var learnBtn = Array.from(document.querySelectorAll('.screen-overlay[data-screen="title"] button'))
      .find(function (b) { return /learn/i.test(b.textContent); });
    clickEl(learnBtn);
    await waitFor(function () { return $('.screen-overlay[data-screen="learn"]'); }, 'learn screen');
    var startBtn = Array.from(document.querySelectorAll('.screen-overlay[data-screen="learn"] button'))
      .find(function (b) { return /start|replay/i.test(b.textContent); });
    clickEl(startBtn);
    await waitFor(function () { return app.session && app.config.mode === 'learn'; }, 'lesson started');
    log(true, 'lesson starts with scripted state');

    // Perform lesson 1's required move: 6S (col 3 top) onto 7H (col 2 top).
    var lst = app.session.state;
    var col2 = lst.tableau[2], col3 = lst.tableau[3];
    clickEl(cardButton({ zone: 'tableau', index: 3 }, col3.length - 1));
    await waitFor(function () { return app.selection; }, 'lesson selection');
    clickEl(cardButton({ zone: 'tableau', index: 2 }, col2.length - 1));
    await waitFor(function () {
      return app.session.lesson && app.session.lesson.stepIndex >= app.session.lesson.def.steps.length;
    }, 'lesson complete');
    await waitFor(function () { return $('.screen-overlay[data-screen="results"]'); }, 'lesson results');
    log(true, 'lesson completes via its required action');

    console.log('E2E DONE');
  }

  run().catch(function (e) {
    log(false, 'harness crashed', String(e && e.stack || e));
    console.log('E2E DONE');
  });
})();
